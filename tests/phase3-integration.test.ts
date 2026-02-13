import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { createAgent } from '../src/core/agent.js';
import { createLLMRouter } from '../src/llm/router.js';
import type { LLMProviderInterface, LLMRequest, LLMResponse } from '../src/llm/types.js';
import { createConsolidatedMemoryStore } from '../src/memory/consolidated.js';
import { createConsolidationEngine } from '../src/memory/consolidation.js';
import { createDecayEngine } from '../src/memory/decay.js';
import { createEmbeddingService } from '../src/memory/embeddings.js';
import { createEpisodicMemory } from '../src/memory/episodic.js';
import { createMemoryRetrievalPipeline } from '../src/memory/retrieval.js';
import { createSoul } from '../src/memory/soul.js';
import { createMemoryStore } from '../src/memory/store.js';
import { createWorkingMemory } from '../src/memory/working.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

afterAll(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

const KEYWORDS = ['mama', 'memory', 'project', 'pipeline', 'release', 'goal', 'docs', 'typescript'];

function createMockClaudeProvider(calls: LLMRequest[]): LLMProviderInterface {
	return {
		name: 'claude',
		complete: vi.fn(async (request: LLMRequest): Promise<LLMResponse> => {
			calls.push(request);

			if (request.taskType === 'memory_consolidation') {
				return {
					content: JSON.stringify({
						new: [
							{
								category: 'project',
								content: 'User is building the Mama memory pipeline project.',
								confidence: 0.92,
							},
						],
						reinforce: [],
						update: [],
						contradict: [],
						decay: [],
						connect: [],
					}),
					toolCalls: [],
					usage: { inputTokens: 350, outputTokens: 110 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				};
			}

			const latestUser = [...request.messages]
				.reverse()
				.find((message) => message.role === 'user')
				?.content.toLowerCase();
			const memoryLine =
				request.systemPrompt
					?.split('\n')
					.find((line) => line.includes('[memory/') && line.includes('Mama memory pipeline')) ?? '';

			let content = 'Noted. I will help with your request.';
			if (latestUser?.includes('what do you know')) {
				content = memoryLine
					? 'I know you are building the Mama memory pipeline project.'
					: 'I do not have strong consolidated knowledge yet.';
			} else if (latestUser?.includes('project')) {
				content = 'Understood. We can continue advancing your project.';
			}

			return {
				content,
				toolCalls: [],
				usage: { inputTokens: 140, outputTokens: 60 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'end',
			};
		}),
		isAvailable: vi.fn(async () => true),
	};
}

describe('Phase 3.7 integration scenarios', () => {
	it('stores episodes, consolidates, retrieves context, and applies decay', async () => {
		const configResult = loadConfig('/nonexistent/config.yaml');
		if (!configResult.ok) {
			throw configResult.error;
		}
		const config = configResult.value;
		const root = createTempRoot('mama-phase3-');
		const calls: LLMRequest[] = [];

		const store = createMemoryStore({ dbPath: join(root, 'mama.db') });
		const embeddings = createEmbeddingService({
			embedder: async (text: string) => {
				const normalized = text.toLowerCase();
				return KEYWORDS.map((keyword) => (normalized.includes(keyword) ? 1 : 0));
			},
		});
		const episodic = createEpisodicMemory({
			store,
			embeddings,
			defaultTopK: config.memory.searchTopK,
		});
		const consolidated = createConsolidatedMemoryStore({
			store,
			embeddings,
			defaultTopK: config.memory.searchTopK,
		});
		const retrieval = createMemoryRetrievalPipeline({
			store,
			episodic,
			consolidated,
		});
		const soul = createSoul({
			soulPath: join(root, 'soul.md'),
			userName: 'Alex',
			agentName: 'Mama',
		});

		const router = createLLMRouter({
			config,
			claudeProvider: createMockClaudeProvider(calls),
		});
		const agent = createAgent({
			router,
			workingMemory: createWorkingMemory({ maxTokens: 100000 }),
			soul,
			episodicMemory: episodic,
			retrieval,
		});
		const consolidation = createConsolidationEngine({
			router,
			store,
			episodic,
			consolidated,
			embeddings,
			soul,
			minEpisodesToConsolidate: 1,
		});

		// Scenario 1: Conversation about a project creates episodes.
		await agent.processMessage(
			'I am building a Mama memory pipeline project and need to ship this release.',
			'terminal',
		);
		const episodes = store.all<{ id: string; role: string; content: string }>(
			'SELECT id, role, content FROM episodes ORDER BY timestamp ASC',
		);
		expect(episodes.length).toBeGreaterThanOrEqual(2);
		expect(
			episodes.some(
				(row) => row.role === 'user' && row.content.toLowerCase().includes('memory pipeline'),
			),
		).toBe(true);

		// Scenario 2: Semantic search recalls that conversation.
		const semantic = await episodic.searchSemantic('mama memory pipeline project', { topK: 3 });
		expect(semantic.length).toBeGreaterThan(0);
		expect(semantic[0]?.content.toLowerCase()).toContain('memory pipeline');

		// Scenario 3: Run consolidation and verify consolidated memories are created.
		const consolidationReport = await consolidation.runConsolidation({ force: true, runDecay: false });
		expect(consolidationReport.skipped).toBe(false);
		expect(consolidationReport.created).toBeGreaterThan(0);

		const consolidatedMatches = await consolidated.search('mama memory pipeline project', {
			topK: 5,
			minConfidence: 0,
			includeInactive: true,
		});
		expect(consolidatedMatches.length).toBeGreaterThan(0);
		const memory = consolidatedMatches[0];
		if (!memory) {
			throw new Error('Expected a consolidated memory after consolidation');
		}

		// Scenario 4: New conversation should receive retrieved memory context in system prompt.
		await agent.processMessage('What should be the next step for my project?', 'terminal');
		const latestRequest = calls[calls.length - 1];
		expect(latestRequest?.systemPrompt).toContain('[memory/project');
		expect(latestRequest?.systemPrompt).toContain('Mama memory pipeline project');

		// Scenario 5: Asking what Mama knows should reference consolidated knowledge.
		const knowledgeResponse = await agent.processMessage('What do you know about this project?', 'terminal');
		expect(knowledgeResponse.content.toLowerCase()).toContain('mama memory pipeline project');

		// Scenario 6: Run decay and verify unreinforced memory confidence is reduced.
		const oldDate = new Date('2025-12-01T00:00:00.000Z').toISOString();
		store.run('UPDATE memories SET last_reinforced_at = ?, confidence = ? WHERE id = ?', [
			oldDate,
			0.6,
			memory.id,
		]);
		const before = store.get<{ confidence: number }>('SELECT confidence FROM memories WHERE id = ?', [
			memory.id,
		]);
		const decay = createDecayEngine({
			store,
			consolidated,
			now: new Date('2026-02-13T00:00:00.000Z'),
			inactiveDaysThreshold: 30,
			decayFactor: 0.5,
			deactivateThreshold: 0.1,
		});
		const decayReport = await decay.runDecay();
		const after = store.get<{ confidence: number }>('SELECT confidence FROM memories WHERE id = ?', [
			memory.id,
		]);

		expect(decayReport.decayed).toBeGreaterThan(0);
		expect((before?.confidence ?? 0) > (after?.confidence ?? 1)).toBe(true);

		store.close();
	});
});
