import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import type { AuditEntry } from './types.js';

const logger = createLogger('sandbox:audit');

interface AuditFilters {
	capability?: string;
	action?: string;
	result?: string;
	since?: Date;
	until?: Date;
	requestedBy?: string;
}

interface AuditStore {
	log(entry: AuditEntry): void;
	query(filters: AuditFilters): AuditEntry[];
	getRecent(limit: number): AuditEntry[];
	close(): void;
}

function createInMemoryAuditStore(): AuditStore {
	const entries: AuditEntry[] = [];

	function toStoredEntry(entry: AuditEntry): AuditEntry {
		return {
			...entry,
			output: entry.output?.slice(0, 1024),
			params: entry.params ? JSON.parse(JSON.stringify(entry.params)) : undefined,
		};
	}

	function sortNewest(items: AuditEntry[]): AuditEntry[] {
		return [...items].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
	}

	return {
		log(entry: AuditEntry): void {
			entries.push(toStoredEntry(entry));
		},
		query(filters: AuditFilters): AuditEntry[] {
			const filtered = entries.filter((entry) => {
				if (filters.capability && entry.capability !== filters.capability) return false;
				if (filters.action && entry.action !== filters.action) return false;
				if (filters.result && entry.result !== filters.result) return false;
				if (filters.requestedBy && entry.requestedBy !== filters.requestedBy) return false;
				if (filters.since && entry.timestamp < filters.since) return false;
				if (filters.until && entry.timestamp > filters.until) return false;
				return true;
			});
			return sortNewest(filtered).slice(0, 1000);
		},
		getRecent(limit: number): AuditEntry[] {
			return sortNewest(entries).slice(0, limit);
		},
		close(): void {
			// No-op for in-memory store
		},
	};
}

/**
 * Creates an append-only audit log backed by SQLite.
 * Uses WAL mode for crash safety.
 */
export function createAuditStore(dbPath: string): AuditStore {
	let db: InstanceType<typeof Database>;
	try {
		db = new Database(dbPath);
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.warn('SQLite audit store unavailable, using in-memory fallback', { reason });
		return createInMemoryAuditStore();
	}

	// Enable WAL mode for crash safety
	db.pragma('journal_mode = WAL');

	// Create table
	db.exec(`
		CREATE TABLE IF NOT EXISTS audit_log (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			capability TEXT NOT NULL,
			action TEXT NOT NULL,
			resource TEXT,
			params TEXT,
			decision TEXT NOT NULL,
			result TEXT NOT NULL,
			output TEXT,
			error TEXT,
			duration_ms INTEGER,
			requested_by TEXT
		)
	`);

	// Create indexes for common queries
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
		CREATE INDEX IF NOT EXISTS idx_audit_capability ON audit_log(capability);
		CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result);
	`);

	const insertStmt = db.prepare(`
		INSERT INTO audit_log (id, timestamp, capability, action, resource, params, decision, result, output, error, duration_ms, requested_by)
		VALUES (@id, @timestamp, @capability, @action, @resource, @params, @decision, @result, @output, @error, @durationMs, @requestedBy)
	`);

	const queryStmt = db.prepare(`
		SELECT * FROM audit_log
		WHERE (@capability IS NULL OR capability = @capability)
		AND (@action IS NULL OR action = @action)
		AND (@result IS NULL OR result = @result)
		AND (@since IS NULL OR timestamp >= @since)
		AND (@until IS NULL OR timestamp <= @until)
		AND (@requestedBy IS NULL OR requested_by = @requestedBy)
		ORDER BY timestamp DESC
		LIMIT 1000
	`);

	const recentStmt = db.prepare(`
		SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
	`);

	function log(entry: AuditEntry): void {
		// Truncate output to 1KB for storage
		const truncatedOutput = entry.output?.slice(0, 1024);

		insertStmt.run({
			id: entry.id,
			timestamp: entry.timestamp.toISOString(),
			capability: entry.capability,
			action: entry.action,
			resource: entry.resource ?? '',
			params: entry.params ? JSON.stringify(entry.params) : null,
			decision: entry.decision,
			result: entry.result,
			output: truncatedOutput ?? null,
			error: entry.error ?? null,
			durationMs: entry.durationMs,
			requestedBy: entry.requestedBy,
		});

		logger.debug('Audit entry logged', {
			id: entry.id,
			capability: entry.capability,
			action: entry.action,
			decision: entry.decision,
			result: entry.result,
		});
	}

	function rowToEntry(row: Record<string, unknown>): AuditEntry {
		return {
			id: row.id as string,
			timestamp: new Date(row.timestamp as string),
			capability: row.capability as string,
			action: row.action as string,
			resource: row.resource as string,
			params: row.params ? JSON.parse(row.params as string) : undefined,
			decision: row.decision as AuditEntry['decision'],
			result: row.result as AuditEntry['result'],
			output: (row.output as string) ?? undefined,
			error: (row.error as string) ?? undefined,
			durationMs: row.duration_ms as number,
			requestedBy: row.requested_by as string,
		};
	}

	function query(filters: AuditFilters): AuditEntry[] {
		const rows = queryStmt.all({
			capability: filters.capability ?? null,
			action: filters.action ?? null,
			result: filters.result ?? null,
			since: filters.since?.toISOString() ?? null,
			until: filters.until?.toISOString() ?? null,
			requestedBy: filters.requestedBy ?? null,
		}) as Record<string, unknown>[];

		return rows.map(rowToEntry);
	}

	function getRecent(limit: number): AuditEntry[] {
		const rows = recentStmt.all(limit) as Record<string, unknown>[];
		return rows.map(rowToEntry);
	}

	function close(): void {
		db.close();
	}

	return { log, query, getRecent, close };
}
