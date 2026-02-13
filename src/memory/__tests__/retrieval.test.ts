import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsolidatedMemoryStore } from '../consolidated.js';
import { createEmbeddingService } from '../embeddings.js';
import { createEpisodicMemory } from '../episodic.js';
import { createMemoryRetrievalPipeline } from '../retrieval.js';
import { createMemoryStore } from '../store.js';

const tempRoots: string[] = [];
const KEYWORDS = ['typescript', 'memory', 'release', 'goal', 'project', 'docs', 'coffee', 'tests'];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function createKeywordEmbeddings() {
	return createEmbeddingService({
		embedder: async (text: string) => {
			const normalized = text.toLowerCase();
			return KEYWORDS.map((keyword) => (normalized.includes(keyword) ? 1 : 0));
		},
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

describe('memory retrieval pipeline (Task 3.5)', () => {
	it('retrieves relevant memories, recent episodes and active goals', async () => {
		const root = createTempRoot('mama-retrieval-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const embeddings = createKeywordEmbeddings();
		const consolidated = createConsolidatedMemoryStore({ store, embeddings });
		const episodic = createEpisodicMemory({ store, embeddings });
		const retrieval = createMemoryRetrievalPipeline({
			store,
			episodic,
			consolidated,
		});

		await consolidated.create({
			category: 'project',
			content: 'Main project uses TypeScript memory retrieval with strict tests',
			confidence: 0.92,
		});
		await consolidated.create({
			category: 'preference',
			content: 'User likes coffee in the morning',
			confidence: 0.6,
		});

		await episodic.storeEpisode({
			timestamp: new Date(Date.now() - 20 * 60 * 1000),
			channel: 'terminal',
			role: 'user',
			content: 'Please finish TypeScript memory retrieval docs today',
		});
		await episodic.storeEpisode({
			timestamp: new Date(Date.now() - 27 * 60 * 60 * 1000),
			channel: 'terminal',
			role: 'assistant',
			content: 'Old context that should be excluded by 24h window',
		});

		store.run(
			`INSERT INTO jobs (id, name, type, schedule, task, enabled)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				'job-1',
				'Release Memory',
				'cron',
				'every day',
				'Ship TypeScript memory retrieval release and docs',
				1,
			],
		);

		const context = await retrieval.retrieveContext('typescript memory retrieval release', 300);
		expect(context.tokenCount).toBeLessThanOrEqual(300);
		expect(context.entries.length).toBeGreaterThan(0);
		expect(context.formatted).toContain('\n');
		expect(context.entries.some((entry) => entry.includes('[memory/project'))).toBe(true);
		expect(context.entries.some((entry) => entry.includes('[recent/user]'))).toBe(true);
		expect(context.entries.some((entry) => entry.includes('[goal/Release Memory]'))).toBe(true);

		store.close();
	});

	it('respects token budget constraints', async () => {
		const root = createTempRoot('mama-retrieval-budget-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const embeddings = createKeywordEmbeddings();
		const consolidated = createConsolidatedMemoryStore({ store, embeddings });
		const episodic = createEpisodicMemory({ store, embeddings });
		const retrieval = createMemoryRetrievalPipeline({ store, episodic, consolidated });

		await consolidated.create({
			category: 'fact',
			content: 'TypeScript memory retrieval keeps context compact and relevant',
			confidence: 0.8,
		});
		await episodic.storeEpisode({
			channel: 'terminal',
			role: 'user',
			content: 'Short reminder about memory retrieval docs',
		});

		const tinyBudget = await retrieval.retrieveContext('memory retrieval', 8);
		expect(tinyBudget.tokenCount).toBeLessThanOrEqual(8);
		expect(tinyBudget.entries.length).toBeLessThanOrEqual(1);

		store.close();
	});

	it('prioritizes higher-confidence memories when relevance is similar', async () => {
		const root = createTempRoot('mama-retrieval-confidence-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const embeddings = createKeywordEmbeddings();
		const consolidated = createConsolidatedMemoryStore({ store, embeddings });
		const episodic = createEpisodicMemory({ store, embeddings });
		const retrieval = createMemoryRetrievalPipeline({ store, episodic, consolidated });

		await consolidated.create({
			category: 'fact',
			content: 'TypeScript memory retrieval is stable for project docs',
			confidence: 0.95,
		});
		await consolidated.create({
			category: 'fact',
			content: 'TypeScript memory retrieval is experimental for project docs',
			confidence: 0.45,
		});

		const context = await retrieval.retrieveContext('typescript memory retrieval docs', 200);
		const memoryEntries = context.entries.filter((entry) => entry.startsWith('[memory/'));
		expect(memoryEntries.length).toBeGreaterThanOrEqual(2);
		expect(memoryEntries[0]).toContain('stable');

		store.close();
	});
});
