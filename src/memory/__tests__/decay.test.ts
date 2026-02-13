import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsolidatedMemoryStore } from '../consolidated.js';
import { createDecayEngine } from '../decay.js';
import { createEmbeddingService } from '../embeddings.js';
import { createMemoryStore } from '../store.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function createEmbeddings() {
	return createEmbeddingService({
		embedder: async (text) => [text.length % 7, text.length % 5, text.length % 3],
	});
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe('decay engine (Task 3.4)', () => {
	it('decays stale memories and deactivates below threshold', async () => {
		const root = createTempRoot('mama-decay-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const consolidated = createConsolidatedMemoryStore({
			store,
			embeddings: createEmbeddings(),
		});

		const oldLow = await consolidated.create({
			category: 'pattern',
			content: 'Old low-confidence pattern',
			confidence: 0.2,
		});
		const oldMedium = await consolidated.create({
			category: 'fact',
			content: 'Old medium-confidence fact',
			confidence: 0.5,
		});
		const recent = await consolidated.create({
			category: 'goal',
			content: 'Recent active goal',
			confidence: 0.9,
		});

		await consolidated.update(oldLow, { lastReinforcedAt: new Date('2025-01-01T00:00:00.000Z') });
		await consolidated.update(oldMedium, {
			lastReinforcedAt: new Date('2025-01-01T00:00:00.000Z'),
		});
		await consolidated.update(recent, { lastReinforcedAt: new Date('2026-02-10T00:00:00.000Z') });

		const decay = createDecayEngine({
			store,
			consolidated,
			inactiveDaysThreshold: 30,
			decayFactor: 0.5,
			deactivateThreshold: 0.15,
			now: new Date('2026-02-13T00:00:00.000Z'),
		});

		const report = await decay.runDecay();
		expect(report.checked).toBe(3);
		expect(report.decayed).toBe(2);
		expect(report.deactivated).toBe(1);

		const oldLowState = store.get<{ confidence: number; active: number }>(
			'SELECT confidence, active FROM memories WHERE id = ?',
			[oldLow],
		);
		expect(oldLowState?.confidence).toBeCloseTo(0.1, 5);
		expect(oldLowState?.active).toBe(0);

		const oldMediumState = store.get<{ confidence: number; active: number }>(
			'SELECT confidence, active FROM memories WHERE id = ?',
			[oldMedium],
		);
		expect(oldMediumState?.confidence).toBeCloseTo(0.25, 5);
		expect(oldMediumState?.active).toBe(1);

		const recentState = store.get<{ confidence: number; active: number }>(
			'SELECT confidence, active FROM memories WHERE id = ?',
			[recent],
		);
		expect(recentState?.confidence).toBeCloseTo(0.9, 5);
		expect(recentState?.active).toBe(1);

		store.close();
	});
});
