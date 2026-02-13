import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getMamaHome } from '../config/defaults.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('memory:store');

export interface AppliedMigration {
	version: number;
	name: string;
	appliedAt: string;
}

export interface MigrationRunResult {
	applied: string[];
	skipped: string[];
}

interface MigrationFile {
	version: number;
	name: string;
	path: string;
}

interface CreateMemoryStoreOptions {
	dbPath?: string;
	migrationsDir?: string;
}

export interface MemoryStore {
	getDbPath(): string;
	runMigrations(): MigrationRunResult;
	getAppliedMigrations(): AppliedMigration[];
	listTables(): string[];
	run(sql: string, params?: SQLInputValue[]): void;
	all<T>(sql: string, params?: SQLInputValue[]): T[];
	get<T>(sql: string, params?: SQLInputValue[]): T | undefined;
	transaction<T>(fn: () => T): T;
	close(): void;
}

function defaultDbPath(): string {
	return join(getMamaHome(), 'mama.db');
}

function defaultMigrationsDir(): string {
	const currentFile = fileURLToPath(import.meta.url);
	return join(dirname(currentFile), 'migrations');
}

function parseMigrationVersion(fileName: string): number {
	const match = fileName.match(/^(\d+)_.*\.sql$/);
	if (!match?.[1]) {
		throw new Error(`Invalid migration filename: ${fileName}`);
	}
	return Number.parseInt(match[1], 10);
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
	const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));

	const migrations = files.map((name) => ({
		version: parseMigrationVersion(name),
		name,
		path: join(migrationsDir, name),
	}));

	migrations.sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
	return migrations;
}

function ensureMigrationTable(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL
		)
	`);
}

function withTransaction(db: DatabaseSync, fn: () => void): void {
	db.exec('BEGIN');
	try {
		fn();
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

function runPendingMigrations(db: DatabaseSync, migrationsDir: string): MigrationRunResult {
	const migrations = loadMigrationFiles(migrationsDir);
	const appliedRows = db
		.prepare('SELECT version, name FROM _migrations ORDER BY version ASC')
		.all() as Array<{ version: number; name: string }>;
	const appliedVersions = new Set(appliedRows.map((row) => row.version));

	const insertMigration = db.prepare(
		'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
	);

	const result: MigrationRunResult = { applied: [], skipped: [] };

	for (const migration of migrations) {
		if (appliedVersions.has(migration.version)) {
			result.skipped.push(migration.name);
			continue;
		}

		const sql = readFileSync(migration.path, 'utf-8');
		withTransaction(db, () => {
			db.exec(sql);
			insertMigration.run(migration.version, migration.name, new Date().toISOString());
		});

		result.applied.push(migration.name);
		logger.info('Applied migration', {
			version: migration.version,
			name: migration.name,
		});
	}

	return result;
}

/**
 * Creates the memory SQLite store and applies schema migrations.
 */
export function createMemoryStore(options: CreateMemoryStoreOptions = {}): MemoryStore {
	const dbPath = options.dbPath ?? defaultDbPath();
	const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();

	if (dbPath !== ':memory:') {
		mkdirSync(dirname(dbPath), { recursive: true });
	}

	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	ensureMigrationTable(db);
	runPendingMigrations(db, migrationsDir);

	function runMigrations(): MigrationRunResult {
		return runPendingMigrations(db, migrationsDir);
	}

	function getAppliedMigrations(): AppliedMigration[] {
		const rows = db
			.prepare('SELECT version, name, applied_at FROM _migrations ORDER BY version ASC')
			.all() as Array<{
			version: number;
			name: string;
			applied_at: string;
		}>;
		return rows.map((row) => ({
			version: row.version,
			name: row.name,
			appliedAt: row.applied_at,
		}));
	}

	function listTables(): string[] {
		const rows = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
			)
			.all() as Array<{ name: string }>;
		return rows.map((row) => row.name);
	}

	function run(sql: string, params: SQLInputValue[] = []): void {
		db.prepare(sql).run(...params);
	}

	function all<T>(sql: string, params: SQLInputValue[] = []): T[] {
		return db.prepare(sql).all(...params) as T[];
	}

	function get<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
		return db.prepare(sql).get(...params) as T | undefined;
	}

	function transaction<T>(fn: () => T): T {
		let result: T | undefined;
		withTransaction(db, () => {
			result = fn();
		});
		return result as T;
	}

	function close(): void {
		db.close();
	}

	return {
		getDbPath: () => dbPath,
		runMigrations,
		getAppliedMigrations,
		listTables,
		run,
		all,
		get,
		transaction,
		close,
	};
}
