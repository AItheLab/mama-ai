import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmbeddingService } from '../embeddings.js';
import { createEpisodicMemory } from '../episodic.js';
import { createMemoryStore } from '../store.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

const KEYWORDS = ['project', 'docs', 'coffee', 'error', 'release', 'plan'];

function createKeywordEmbedder() {
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

describe('episodic memory (Task 3.2)', () => {
	it('stores episodes and returns recent entries', async () => {
		const root = createTempRoot('mama-episodic-recent-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const episodic = createEpisodicMemory({
			store,
			embeddings: createKeywordEmbedder(),
		});

		await episodic.storeEpisode({
			timestamp: new Date('2026-01-10T10:00:00.000Z'),
			channel: 'terminal',
			role: 'user',
			content: 'Project docs need updates before release',
		});
		await episodic.storeEpisode({
			timestamp: new Date('2026-01-11T10:00:00.000Z'),
			channel: 'terminal',
			role: 'assistant',
			content: 'I updated the release checklist and docs',
		});

		const recent = await episodic.getRecent(2);
		expect(recent).toHaveLength(2);
		expect(recent[0]?.content).toContain('checklist');
		expect(recent[1]?.content).toContain('Project docs');
		expect(recent[0]?.metadata.topics?.length).toBeGreaterThan(0);
		store.close();
	});

	it('supports semantic and temporal search', async () => {
		const root = createTempRoot('mama-episodic-search-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const episodic = createEpisodicMemory({
			store,
			embeddings: createKeywordEmbedder(),
		});

		const oldId = await episodic.storeEpisode({
			timestamp: new Date('2026-01-01T08:00:00.000Z'),
			channel: 'terminal',
			role: 'user',
			content: 'Coffee preferences and morning routine',
		});
		const projectId = await episodic.storeEpisode({
			timestamp: new Date('2026-01-04T09:30:00.000Z'),
			channel: 'terminal',
			role: 'user',
			content: 'Project plan and docs are blocked by release error',
		});
		await episodic.storeEpisode({
			timestamp: new Date('2026-01-06T12:00:00.000Z'),
			channel: 'terminal',
			role: 'assistant',
			content: 'General smalltalk without relevant tokens',
		});

		const semantic = await episodic.searchSemantic('project docs release', { topK: 2 });
		expect(semantic[0]?.id).toBe(projectId);

		const temporal = await episodic.searchTemporal(
			new Date('2026-01-02T00:00:00.000Z'),
			new Date('2026-01-05T23:59:59.999Z'),
		);
		expect(temporal.map((item) => item.id)).toEqual([projectId]);

		await episodic.markConsolidated([oldId, projectId]);
		const updated = await episodic.getRecent(3);
		expect(updated.filter((item) => item.consolidated)).toHaveLength(2);
		store.close();
	});

	it('hybrid search can favor recency when configured', async () => {
		const root = createTempRoot('mama-episodic-hybrid-');
		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const episodic = createEpisodicMemory({
			store,
			embeddings: createKeywordEmbedder(),
		});

		await episodic.storeEpisode({
			timestamp: new Date('2025-01-01T00:00:00.000Z'),
			channel: 'terminal',
			role: 'user',
			content: 'project docs plan',
		});
		const recentId = await episodic.storeEpisode({
			timestamp: new Date('2026-02-12T00:00:00.000Z'),
			channel: 'terminal',
			role: 'user',
			content: 'coffee note',
		});

		const hybrid = await episodic.searchHybrid('project', {
			topK: 1,
			semanticWeight: 0,
			temporalWeight: 1,
			topicWeight: 0,
		});
		expect(hybrid[0]?.id).toBe(recentId);
		store.close();
	});
});
