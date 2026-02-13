import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../memory/store.js';
import { createCostTracker } from '../cost-tracker.js';

const tempRoots: string[] = [];

function createTempDbPath(): string {
	const root = mkdtempSync(join(tmpdir(), 'mama-cost-test-'));
	tempRoots.push(root);
	return join(root, 'mama.db');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe('CostTracker persistence', () => {
	it('persists llm usage records to SQLite and reloads them', () => {
		const dbPath = createTempDbPath();
		const store1 = createMemoryStore({ dbPath });
		const tracker1 = createCostTracker({ store: store1 });

		tracker1.record({
			provider: 'claude',
			model: 'claude-sonnet-4-20250514',
			usage: { inputTokens: 1000, outputTokens: 500 },
			taskType: 'general',
			latencyMs: 120,
		});
		expect(store1.all('SELECT id FROM llm_usage')).toHaveLength(1);
		store1.close();

		const store2 = createMemoryStore({ dbPath });
		const tracker2 = createCostTracker({ store: store2 });
		expect(tracker2.getRecords()).toHaveLength(1);
		expect(tracker2.getTotalCost()).toBeGreaterThan(0);
		store2.close();
	});
});
