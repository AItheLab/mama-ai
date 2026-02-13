import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsolidatedMemoryStore } from '../../memory/consolidated.js';
import type { ConsolidationEngine } from '../../memory/consolidation.js';
import { createEmbeddingService } from '../../memory/embeddings.js';
import { createEpisodicMemory } from '../../memory/episodic.js';
import { createMemoryStore } from '../../memory/store.js';
import { createMemoryCliHandlers, type MemoryCliServices } from '../memory.js';

const tempRoots: string[] = [];
const KEYWORDS = ['typescript', 'memory', 'release', 'goal', 'project', 'docs', 'coffee'];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function createEmbeddings() {
	return createEmbeddingService({
		embedder: async (text: string) => {
			const normalized = text.toLowerCase();
			return KEYWORDS.map((keyword) => (normalized.includes(keyword) ? 1 : 0));
		},
	});
}

function createServices(
	consolidation?: ConsolidationEngine,
): Omit<MemoryCliServices, 'close'> & { close: () => void } {
	const root = createTempRoot('mama-cli-memory-');
	const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
	const embeddings = createEmbeddings();
	const episodic = createEpisodicMemory({ store, embeddings });
	const consolidated = createConsolidatedMemoryStore({ store, embeddings });

	return {
		store,
		episodic,
		consolidated,
		consolidation,
		close() {
			store.close();
		},
	};
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe('memory CLI handlers (Task 3.6)', () => {
	it('searches across consolidated and episodic memories', async () => {
		const services = createServices();
		const handlers = createMemoryCliHandlers(services, { enabled: false });

		await services.consolidated.create({
			category: 'project',
			content: 'TypeScript memory retrieval roadmap is active',
			confidence: 0.9,
		});
		await services.episodic.storeEpisode({
			channel: 'terminal',
			role: 'user',
			content: 'Please update TypeScript memory docs for release',
		});

		const output = await handlers.search('typescript memory', { limit: 5 });
		expect(output).toContain('Consolidated Memories');
		expect(output).toContain('Episodic Memories');
		expect(output.toLowerCase()).toContain('typescript');

		services.close();
	});

	it('lists consolidated memories with filters', async () => {
		const services = createServices();
		const handlers = createMemoryCliHandlers(services, { enabled: false });

		await services.consolidated.create({
			category: 'goal',
			content: 'Ship memory CLI commands',
			confidence: 0.85,
		});
		await services.consolidated.create({
			category: 'fact',
			content: 'User drinks coffee',
			confidence: 0.4,
		});

		const output = await handlers.list({ category: 'goal', minConfidence: 0.7 });
		expect(output).toContain('category=goal');
		expect(output).toContain('Ship memory CLI commands');
		expect(output).not.toContain('User drinks coffee');

		services.close();
	});

	it('forgets a memory by deactivating it', async () => {
		const services = createServices();
		const handlers = createMemoryCliHandlers(services, { enabled: false });

		const id = await services.consolidated.create({
			category: 'fact',
			content: 'Temporary memory',
			confidence: 0.7,
		});

		const response = await handlers.forget(id);
		expect(response).toContain('Memory deactivated');

		const active = await services.consolidated.getActive(0);
		expect(active.some((memory) => memory.id === id)).toBe(false);

		services.close();
	});

	it('reports stats and category distribution', async () => {
		const services = createServices();
		const handlers = createMemoryCliHandlers(services, { enabled: false });

		await services.consolidated.create({
			category: 'project',
			content: 'Project memory',
		});
		await services.episodic.storeEpisode({
			channel: 'terminal',
			role: 'assistant',
			content: 'Episode for stats',
		});

		const output = await handlers.stats();
		expect(output).toContain('Memory Stats');
		expect(output).toContain('Episodes');
		expect(output).toContain('Consolidated Memories');
		expect(output).toContain('project');

		services.close();
	});

	it('runs manual consolidation and renders report', async () => {
		const consolidation: ConsolidationEngine = {
			getPendingEpisodeCount: () => 12,
			runConsolidation: async () => ({
				startedAt: '2026-02-13T00:00:00.000Z',
				finishedAt: '2026-02-13T00:00:10.000Z',
				skipped: false,
				pendingEpisodes: 12,
				processedEpisodes: 12,
				created: 2,
				reinforced: 3,
				updated: 1,
				contradicted: 0,
				decayed: 1,
				deactivated: 0,
				connected: 2,
				errors: [],
			}),
		};
		const services = createServices(consolidation);
		const handlers = createMemoryCliHandlers(services, { enabled: false });

		const output = await handlers.consolidate();
		expect(output).toContain('Consolidation Report');
		expect(output).toContain('Processed episodes');
		expect(output).toContain('12');
		expect(output).toContain('Created');

		services.close();
	});
});
