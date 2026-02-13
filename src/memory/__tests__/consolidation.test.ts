import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsolidatedMemoryStore } from '../consolidated.js';
import {
	buildConsolidationPrompt,
	createConsolidationEngine,
	createConsolidationScheduler,
	parseConsolidationResponse,
} from '../consolidation.js';
import { createEmbeddingService } from '../embeddings.js';
import { createEpisodicMemory } from '../episodic.js';
import { createSoul } from '../soul.js';
import { createMemoryStore } from '../store.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function createEmbeddings() {
	return createEmbeddingService({
		embedder: async (text) => {
			const normalized = text.toLowerCase();
			return [
				normalized.includes('typescript') ? 1 : 0,
				normalized.includes('project') ? 1 : 0,
				normalized.includes('goal') ? 1 : 0,
				normalized.includes('memory') ? 1 : 0,
			];
		},
	});
}

function createRouterWithResponse(content: string) {
	return {
		complete: vi.fn(async () => ({
			content,
			toolCalls: [],
			usage: { inputTokens: 200, outputTokens: 120 },
			model: 'claude-sonnet-4-20250514',
			provider: 'claude' as const,
			finishReason: 'end' as const,
		})),
		route: vi.fn(),
		getCostTracker: vi.fn(),
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

describe('consolidation engine (Task 3.4)', () => {
	it('builds prompt and parses fenced JSON response', () => {
		const prompt = buildConsolidationPrompt({
			existingMemories: [
				{
					id: 'm-1',
					category: 'fact',
					content: 'User writes code daily',
					confidence: 0.8,
					source_episodes: '[]',
					reinforcement_count: 2,
					last_reinforced_at: null,
					contradictions: '[]',
					active: 1,
				},
			],
			episodes: [
				{
					id: 'e-1',
					timestamp: new Date('2026-02-13T12:00:00.000Z'),
					channel: 'terminal',
					role: 'user',
					content: 'Remember this',
					embedding: null,
					metadata: {},
					consolidated: false,
				},
			],
		});
		expect(prompt).toContain('Current consolidated memories');
		expect(prompt).toContain('"id": "e-1"');

		const parsed = parseConsolidationResponse(`
\`\`\`json
{
  "new": [{"category": "goal", "content": "Ship MVP", "confidence": 0.9, "sourceEpisodes": ["e-1"]}],
  "reinforce": [],
  "update": [],
  "contradict": [],
  "decay": [],
  "connect": []
}
\`\`\`
`);
		expect(parsed.new).toHaveLength(1);
		expect(parsed.new[0]?.category).toBe('goal');
		expect(parsed.new[0]?.content).toContain('Ship MVP');
	});

	it('runs a full consolidation cycle and updates soul', async () => {
		const root = createTempRoot('mama-consolidation-run-');
		const dbPath = join(root, 'mama.db');
		const soulPath = join(root, 'soul.md');
		const store = createMemoryStore({ dbPath });
		const embeddings = createEmbeddings();
		const episodic = createEpisodicMemory({ store, embeddings });
		const consolidated = createConsolidatedMemoryStore({ store, embeddings });
		const soul = createSoul({
			soulPath,
			userName: 'Alex',
			agentName: 'Mama',
		});

		const episodeOne = await episodic.storeEpisode({
			channel: 'terminal',
			role: 'user',
			content: 'I prefer TypeScript for this project',
		});
		await episodic.storeEpisode({
			channel: 'terminal',
			role: 'assistant',
			content: 'We should ship the memory goal this week',
		});

		const reinforceId = await consolidated.create({
			category: 'preference',
			content: 'User prefers TypeScript',
			confidence: 0.7,
		});
		const updateId = await consolidated.create({
			category: 'project',
			content: 'Legacy project note',
			confidence: 0.7,
		});
		const contradictId = await consolidated.create({
			category: 'fact',
			content: 'User always works from office',
			confidence: 0.7,
		});
		const decayId = await consolidated.create({
			category: 'pattern',
			content: 'User codes only in mornings',
			confidence: 0.4,
		});

		const router = createRouterWithResponse(
			JSON.stringify({
				new: [
					{
						category: 'goal',
						content: 'Ship memory consolidation MVP',
						confidence: 0.9,
						sourceEpisodes: [episodeOne],
					},
				],
				reinforce: [{ memoryId: reinforceId, reason: 'Confirmed again' }],
				update: [{ memoryId: updateId, newContent: 'User project is Mama memory engine' }],
				contradict: [{ memoryId: contradictId, contradictedBy: 'episode-contradiction' }],
				decay: [{ memoryId: decayId, newConfidence: 0.05 }],
				connect: [{ memoryA: reinforceId, memoryB: updateId, relationship: 'supports' }],
			}),
		);

		const engine = createConsolidationEngine({
			router: router as never,
			store,
			episodic,
			consolidated,
			embeddings,
			soul,
			minEpisodesToConsolidate: 1,
		});

		const report = await engine.runConsolidation({ minEpisodesToConsolidate: 1, runDecay: false });
		expect(report.skipped).toBe(false);
		expect(report.created).toBe(1);
		expect(report.reinforced).toBe(1);
		expect(report.updated).toBe(1);
		expect(report.contradicted).toBe(1);
		expect(report.decayed).toBe(1);
		expect(report.deactivated).toBe(1);

		const pending = engine.getPendingEpisodeCount();
		expect(pending).toBe(0);

		const reinforced = store.get<{ reinforcement_count: number }>(
			'SELECT reinforcement_count FROM memories WHERE id = ?',
			[reinforceId],
		);
		expect(reinforced?.reinforcement_count).toBe(2);

		const updated = store.get<{ content: string }>('SELECT content FROM memories WHERE id = ?', [
			updateId,
		]);
		expect(updated?.content).toContain('Mama memory engine');

		const contradicted = store.get<{ contradictions: string; confidence: number }>(
			'SELECT contradictions, confidence FROM memories WHERE id = ?',
			[contradictId],
		);
		expect(contradicted?.confidence).toBeCloseTo(0.5, 5);
		expect(JSON.parse(contradicted?.contradictions ?? '[]')).toContain('episode-contradiction');

		const decayed = store.get<{ active: number; confidence: number }>(
			'SELECT active, confidence FROM memories WHERE id = ?',
			[decayId],
		);
		expect(decayed?.active).toBe(0);
		expect(decayed?.confidence).toBeCloseTo(0.05, 5);

		const soulContent = readFileSync(soulPath, 'utf-8');
		expect(soulContent).toContain('## Knowledge');
		expect(soulContent).toContain('## Active Goals');
		expect(soulContent).toContain('Ship memory consolidation MVP');

		store.close();
	});

	it('scheduler skips when active and runs when idle', async () => {
		let idle = false;
		const report = {
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			skipped: false,
			pendingEpisodes: 5,
			processedEpisodes: 5,
			created: 1,
			reinforced: 0,
			updated: 0,
			contradicted: 0,
			decayed: 0,
			deactivated: 0,
			connected: 0,
			errors: [],
		};
		const engine = {
			getPendingEpisodeCount: vi.fn(() => 5),
			runConsolidation: vi.fn(async () => report),
		};
		const scheduler = createConsolidationScheduler({
			engine,
			intervalHours: 1,
			minEpisodesToConsolidate: 2,
			isIdle: () => idle,
		});

		const skipped = await scheduler.runOnce();
		expect(skipped.skipped).toBe(true);
		expect(skipped.skipReason).toContain('active');
		expect(engine.runConsolidation).not.toHaveBeenCalled();

		idle = true;
		const ran = await scheduler.runOnce();
		expect(ran.skipped).toBe(false);
		expect(engine.runConsolidation).toHaveBeenCalledTimes(1);
	});
});
