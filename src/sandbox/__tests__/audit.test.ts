import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditStore } from '../audit.js';
import type { AuditEntry } from '../types.js';

const testDir = join(tmpdir(), 'mama-test-audit');
const testDbPath = join(testDir, 'audit-test.db');

beforeEach(() => {
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
	return {
		id: `test-${Date.now()}-${Math.random()}`,
		timestamp: new Date(),
		capability: 'filesystem',
		action: 'read',
		resource: '/tmp/test.txt',
		decision: 'auto-approved',
		result: 'success',
		durationMs: 5,
		requestedBy: 'agent',
		...overrides,
	};
}

describe('AuditStore', () => {
	it('stores and retrieves audit entries', () => {
		const store = createAuditStore(testDbPath);

		const entry = makeEntry({ id: 'entry-1' });
		store.log(entry);

		const recent = store.getRecent(10);
		expect(recent).toHaveLength(1);
		expect(recent[0]?.id).toBe('entry-1');
		expect(recent[0]?.capability).toBe('filesystem');

		store.close();
	});

	it('stores multiple entries and retrieves in order', () => {
		const store = createAuditStore(testDbPath);

		store.log(makeEntry({ id: 'first', timestamp: new Date('2024-01-01') }));
		store.log(makeEntry({ id: 'second', timestamp: new Date('2024-01-02') }));
		store.log(makeEntry({ id: 'third', timestamp: new Date('2024-01-03') }));

		const recent = store.getRecent(2);
		expect(recent).toHaveLength(2);
		// Most recent first
		expect(recent[0]?.id).toBe('third');
		expect(recent[1]?.id).toBe('second');

		store.close();
	});

	it('filters by capability', () => {
		const store = createAuditStore(testDbPath);

		store.log(makeEntry({ id: 'fs-1', capability: 'filesystem' }));
		store.log(makeEntry({ id: 'sh-1', capability: 'shell' }));
		store.log(makeEntry({ id: 'fs-2', capability: 'filesystem' }));

		const fsEntries = store.query({ capability: 'filesystem' });
		expect(fsEntries).toHaveLength(2);

		const shEntries = store.query({ capability: 'shell' });
		expect(shEntries).toHaveLength(1);

		store.close();
	});

	it('filters by result', () => {
		const store = createAuditStore(testDbPath);

		store.log(makeEntry({ id: 'ok', result: 'success' }));
		store.log(makeEntry({ id: 'fail', result: 'denied' }));
		store.log(makeEntry({ id: 'err', result: 'error' }));

		const denied = store.query({ result: 'denied' });
		expect(denied).toHaveLength(1);
		expect(denied[0]?.id).toBe('fail');

		store.close();
	});

	it('filters by time range', () => {
		const store = createAuditStore(testDbPath);

		store.log(makeEntry({ id: 'old', timestamp: new Date('2024-01-01') }));
		store.log(makeEntry({ id: 'mid', timestamp: new Date('2024-06-01') }));
		store.log(makeEntry({ id: 'new', timestamp: new Date('2024-12-01') }));

		const filtered = store.query({ since: new Date('2024-03-01') });
		expect(filtered).toHaveLength(2);

		store.close();
	});

	it('truncates output to 1KB', () => {
		const store = createAuditStore(testDbPath);

		const longOutput = 'x'.repeat(5000);
		store.log(makeEntry({ id: 'long', output: longOutput }));

		const recent = store.getRecent(1);
		expect(recent[0]?.output?.length).toBeLessThanOrEqual(1024);

		store.close();
	});

	it('stores params as JSON', () => {
		const store = createAuditStore(testDbPath);

		store.log(makeEntry({ id: 'with-params', params: { path: '/tmp', encoding: 'utf-8' } }));

		const recent = store.getRecent(1);
		expect(recent[0]?.params).toEqual({ path: '/tmp', encoding: 'utf-8' });

		store.close();
	});
});
