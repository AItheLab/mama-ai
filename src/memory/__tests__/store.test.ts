import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../store.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function readColumns(dbPath: string, tableName: string): string[] {
	const db = new DatabaseSync(dbPath);
	const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
	db.close();
	return rows.map((row) => row.name);
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe('memory store (Task 3.1)', () => {
	it('creates database and applies initial migration', () => {
		const root = createTempRoot('mama-store-db-');
		const dbPath = join(root, 'mama.db');
		const store = createMemoryStore({ dbPath });

		expect(existsSync(dbPath)).toBe(true);
		expect(store.getAppliedMigrations().map((m) => m.name)).toEqual(
			expect.arrayContaining(['001_initial.sql', '002_memories_reinforcement.sql']),
		);
		expect(store.listTables()).toEqual(
			expect.arrayContaining([
				'_migrations',
				'audit_log',
				'episodes',
				'jobs',
				'llm_usage',
				'memories',
				'skills',
			]),
		);

		store.close();
	});

	it('applies migrations in filename version order', () => {
		const root = createTempRoot('mama-store-order-');
		const dbPath = join(root, 'custom.db');
		const migrationsDir = join(root, 'migrations');
		mkdirSync(migrationsDir, { recursive: true });

		writeFileSync(
			join(migrationsDir, '001_create_seed.sql'),
			'CREATE TABLE ordered_steps (step INTEGER PRIMARY KEY, label TEXT NOT NULL);',
			'utf-8',
		);
		writeFileSync(
			join(migrationsDir, '002_insert_seed.sql'),
			"INSERT INTO ordered_steps (step, label) VALUES (1, 'first'), (2, 'second');",
			'utf-8',
		);
		writeFileSync(
			join(migrationsDir, '010_extend_seed.sql'),
			'ALTER TABLE ordered_steps ADD COLUMN done INTEGER DEFAULT 0;',
			'utf-8',
		);

		const store = createMemoryStore({ dbPath, migrationsDir });
		const applied = store.getAppliedMigrations();
		expect(applied.map((m) => m.version)).toEqual([1, 2, 10]);
		expect(applied.map((m) => m.name)).toEqual([
			'001_create_seed.sql',
			'002_insert_seed.sql',
			'010_extend_seed.sql',
		]);

		const rerun = store.runMigrations();
		expect(rerun.applied).toEqual([]);
		expect(rerun.skipped).toHaveLength(3);
		store.close();

		const db = new DatabaseSync(dbPath);
		const rows = db
			.prepare('SELECT step, label, done FROM ordered_steps ORDER BY step ASC')
			.all() as Array<{ step: number; label: string; done: number }>;
		db.close();

		expect(rows).toEqual([
			{ step: 1, label: 'first', done: 0 },
			{ step: 2, label: 'second', done: 0 },
		]);
	});

	it('matches expected core schema tables and columns', () => {
		const root = createTempRoot('mama-store-schema-');
		const dbPath = join(root, 'schema.db');
		const store = createMemoryStore({ dbPath });
		store.close();

		expect(readColumns(dbPath, 'episodes')).toEqual(
			expect.arrayContaining([
				'id',
				'timestamp',
				'channel',
				'role',
				'content',
				'embedding',
				'metadata',
				'consolidated',
			]),
		);
		expect(readColumns(dbPath, 'memories')).toEqual(
			expect.arrayContaining([
				'id',
				'created_at',
				'updated_at',
				'category',
				'content',
				'confidence',
				'source_episodes',
				'embedding',
				'active',
				'reinforcement_count',
				'last_reinforced_at',
				'contradictions',
			]),
		);
		expect(readColumns(dbPath, 'jobs')).toEqual(
			expect.arrayContaining([
				'id',
				'name',
				'type',
				'schedule',
				'task',
				'enabled',
				'last_run',
				'next_run',
				'run_count',
				'last_result',
			]),
		);
		expect(readColumns(dbPath, 'llm_usage')).toEqual(
			expect.arrayContaining([
				'id',
				'timestamp',
				'provider',
				'model',
				'input_tokens',
				'output_tokens',
				'cost_usd',
				'task_type',
				'latency_ms',
			]),
		);
		expect(readColumns(dbPath, 'skills')).toEqual(
			expect.arrayContaining([
				'name',
				'version',
				'installed_at',
				'manifest',
				'enabled',
				'checksum',
			]),
		);
	});
});
