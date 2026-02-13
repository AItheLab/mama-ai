import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCategory } from '../consolidated.js';
import { createConsolidatedMemoryStore } from '../consolidated.js';
import { createEmbeddingService } from '../embeddings.js';
import { createMemoryStore } from '../store.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

const KEYWORDS = ['typescript', 'javascript', 'coffee', 'project', 'goal', 'pattern'];

function createTestEmbeddings() {
	return createEmbeddingService({
		embedder: async (text: string) => {
			const normalized = text.toLowerCase();
			return KEYWORDS.map((keyword) => (normalized.includes(keyword) ? 1 : 0));
		},
	});
}

async function createStoreWithMemory(category: MemoryCategory, content: string) {
	const root = createTempRoot('mama-consolidated-');
	const dbPath = join(root, 'mama.db');
	const store = createMemoryStore({ dbPath });
	const consolidated = createConsolidatedMemoryStore({
		store,
		embeddings: createTestEmbeddings(),
	});
	const id = await consolidated.create({
		category,
		content,
		sourceEpisodes: ['ep-1'],
		confidence: 0.7,
	});

	return { root, store, consolidated, id };
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe('consolidated memory store (Task 3.3)', () => {
	it('supports create, update and category queries', async () => {
		const { store, consolidated, id } = await createStoreWithMemory(
			'preference',
			'User prefers TypeScript for backend services',
		);

		await consolidated.update(id, {
			category: 'fact',
			content: 'User uses TypeScript daily in production projects',
			confidence: 0.9,
		});

		const facts = await consolidated.getByCategory('fact');
		expect(facts).toHaveLength(1);
		expect(facts[0]?.id).toBe(id);
		expect(facts[0]?.confidence).toBe(0.9);
		expect(facts[0]?.content).toContain('production projects');
		expect(facts[0]?.embedding?.length).toBeGreaterThan(0);

		store.close();
	});

	it('reinforce increments counters and updates confidence', async () => {
		const { store, consolidated, id } = await createStoreWithMemory(
			'pattern',
			'User usually plans project work at night',
		);

		await consolidated.reinforce(id);
		await consolidated.reinforce(id);
		const active = await consolidated.getActive();
		const memory = active.find((item) => item.id === id);

		expect(memory).toBeDefined();
		expect(memory?.reinforcementCount).toBe(3);
		expect(memory?.confidence).toBeCloseTo(0.8, 5);
		expect(memory?.lastReinforcedAt).not.toBeNull();

		store.close();
	});

	it('deactivate/reactivate toggles active state', async () => {
		const { store, consolidated, id } = await createStoreWithMemory(
			'goal',
			'User wants to ship a personal AI agent this quarter',
		);

		await consolidated.deactivate(id);
		expect(await consolidated.getActive()).toHaveLength(0);

		await consolidated.reactivate(id);
		expect(await consolidated.getActive()).toHaveLength(1);

		store.close();
	});

	it('search returns relevant memories by semantic/lexical score', async () => {
		const root = createTempRoot('mama-consolidated-search-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const embedderSpy = vi
			.fn<(text: string) => Promise<number[]>>()
			.mockImplementation(async (text) => {
				const normalized = text.toLowerCase();
				return KEYWORDS.map((keyword) => (normalized.includes(keyword) ? 1 : 0));
			});
		const embeddings = createEmbeddingService({ embedder: embedderSpy });
		const consolidated = createConsolidatedMemoryStore({ store, embeddings });

		await consolidated.create({
			category: 'preference',
			content: 'User prefers TypeScript over JavaScript',
			confidence: 0.9,
		});
		await consolidated.create({
			category: 'fact',
			content: 'User drinks coffee in the morning',
			confidence: 0.8,
		});
		await consolidated.create({
			category: 'project',
			content: 'Current project goal is to finish memory pipeline',
			confidence: 0.85,
		});

		const results = await consolidated.search('typescript preference', { topK: 2 });
		expect(results).toHaveLength(2);
		expect(results[0]?.content.toLowerCase()).toContain('typescript');
		expect(embedderSpy).toHaveBeenCalled();

		store.close();
	});
});
