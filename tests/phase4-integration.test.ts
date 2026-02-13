import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTelegramChannel, type TelegramAdapter } from '../src/channels/telegram.js';
import { runInit } from '../src/cli/init.js';
import { createDaemonController } from '../src/daemon.js';
import { createAgent } from '../src/core/agent.js';
import { createLLMRouter } from '../src/llm/router.js';
import type { LLMProviderInterface, LLMRequest, LLMResponse } from '../src/llm/types.js';
import { createConsolidatedMemoryStore } from '../src/memory/consolidated.js';
import { createDecayEngine } from '../src/memory/decay.js';
import { createEmbeddingService } from '../src/memory/embeddings.js';
import { createEpisodicMemory } from '../src/memory/episodic.js';
import { createMemoryRetrievalPipeline } from '../src/memory/retrieval.js';
import { createSoul } from '../src/memory/soul.js';
import { createMemoryStore } from '../src/memory/store.js';
import { createWorkingMemory } from '../src/memory/working.js';
import { createAuditStore, createFsCapability, createSandbox } from '../src/sandbox/index.js';
import { createCronScheduler } from '../src/scheduler/cron.js';
import { createHeartbeat } from '../src/scheduler/heartbeat.js';

const tempRoots: string[] = [];
const originalMamaHome = process.env.MAMA_HOME;

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function createMockAdapter(sent: Array<{ chatId: number; text: string }>): TelegramAdapter {
	return {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		sendMessage: vi.fn(async (chatId, text) => {
			sent.push({ chatId, text });
		}),
	};
}

function createMockProvider(): LLMProviderInterface {
	return {
		name: 'claude',
		complete: vi.fn(async (request: LLMRequest): Promise<LLMResponse> => {
			const latestUser = [...request.messages].reverse().find((message) => message.role === 'user');
			return {
				content: `Processed: ${latestUser?.content ?? ''}`,
				toolCalls: [],
				usage: { inputTokens: 120, outputTokens: 45 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'end',
			};
		}),
		isAvailable: vi.fn(async () => true),
	};
}

afterAll(() => {
	if (originalMamaHome === undefined) {
		delete process.env.MAMA_HOME;
	} else {
		process.env.MAMA_HOME = originalMamaHome;
	}
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe('Phase 4 integration', () => {
	it('runs init + daemon services + telegram + scheduler + heartbeat + memory/audit/cost flow', async () => {
		const mamaHome = createTempRoot('mama-phase4-home-');
		process.env.MAMA_HOME = mamaHome;

		// 1) mama init
		const initResult = await runInit({
			name: 'Alex',
			telegramToken: 'token',
			claudeApiKey: 'test-key',
			yes: true,
			force: true,
		});
		expect(existsSync(initResult.configPath)).toBe(true);
		expect(existsSync(join(mamaHome, 'workspace'))).toBe(true);
		expect(readFileSync(join(mamaHome, 'heartbeat.md'), 'utf-8')).toContain('Mama Heartbeat');

		// 2) runtime + agent
		const dbPath = join(mamaHome, 'mama.db');
		const store = createMemoryStore({ dbPath });
		const embeddings = createEmbeddingService({
			embedder: async (text: string) =>
				new Float32Array([text.includes('test') ? 1 : 0, text.includes('job') ? 1 : 0]),
		});
		const episodic = createEpisodicMemory({ store, embeddings, defaultTopK: 10 });
		const consolidated = createConsolidatedMemoryStore({ store, embeddings, defaultTopK: 10 });
		const retrieval = createMemoryRetrievalPipeline({
			store,
			episodic,
			consolidated,
			maxMemoryResults: 10,
			maxRecentEpisodes: 20,
			recentWindowHours: 24,
		});
		const soul = createSoul({
			soulPath: join(mamaHome, 'soul.md'),
			userName: 'Alex',
			agentName: 'Mama',
		});
		const router = createLLMRouter({
			config: {
				version: 1,
				agent: { name: 'Mama', soulPath: join(mamaHome, 'soul.md') },
				user: { name: 'Alex', telegramIds: [11], timezone: 'UTC', locale: 'en-US' },
				llm: {
					defaultProvider: 'claude',
					providers: {
						claude: {
							apiKey: 'test',
							defaultModel: 'claude-sonnet-4-20250514',
							maxMonthlyBudgetUsd: 50,
						},
						ollama: {
							host: 'http://localhost:11434',
							apiKey: '',
							defaultModel: 'minimax-m2.5:cloud',
							smartModel: 'minimax-m2.5:cloud',
							fastModel: 'gemini-3-flash-preview:cloud',
							embeddingModel: 'nomic-embed-text',
						},
					},
					routing: {
						complexReasoning: 'claude',
						codeGeneration: 'claude',
						simpleTasks: 'claude',
						embeddings: 'claude',
						memoryConsolidation: 'claude',
						privateContent: 'claude',
					},
				},
				channels: {
					terminal: { enabled: true },
					telegram: { enabled: true, botToken: 'token', defaultChatId: 11 },
					api: { enabled: true, host: '127.0.0.1', port: 3377, token: 'api-token' },
				},
				sandbox: {
					filesystem: {
						workspace: join(mamaHome, 'workspace'),
						allowedPaths: [],
						deniedPaths: [],
					},
					shell: { safeCommands: ['ls'], askCommands: ['git status'], deniedPatterns: ['rm -rf'] },
					network: { allowedDomains: ['localhost'], askDomains: true, rateLimitPerMinute: 30, logAllRequests: true },
				},
				scheduler: {
					heartbeat: {
						enabled: true,
						intervalMinutes: 30,
						heartbeatFile: join(mamaHome, 'heartbeat.md'),
					},
					maxConcurrentJobs: 3,
					triggers: { fileWatchers: [], webhooks: { enabled: false, host: '127.0.0.1', port: 3378, hooks: [] } },
				},
				daemon: { pidFile: join(mamaHome, 'mama.pid'), healthCheckIntervalSeconds: 10 },
				memory: {
					consolidation: { enabled: false, intervalHours: 6, minEpisodesToConsolidate: 10, model: 'claude' },
					maxEpisodicEntries: 100000,
					embeddingDimensions: 768,
					searchTopK: 10,
				},
				logging: { level: 'info', file: join(mamaHome, 'mama.log'), maxSizeMb: 10, rotate: true },
			},
			claudeProvider: createMockProvider(),
			usageStore: store,
		});
		const auditStore = createAuditStore(dbPath);
		const sandbox = createSandbox(auditStore);
		sandbox.register(createFsCapability({ workspace: join(mamaHome, 'workspace'), allowedPaths: [], deniedPaths: [] }, mamaHome));
		sandbox.setApprovalHandler(async () => true);

		const agent = createAgent({
			router,
			workingMemory: createWorkingMemory({ maxTokens: 100000 }),
			soul,
			sandbox,
			episodicMemory: episodic,
			retrieval,
		});
		const chat = await agent.processMessage('Save this test memory', 'terminal');
		expect(chat.content).toContain('Processed');

		// 3) scheduler + heartbeat + daemon controller
		const scheduler = await createCronScheduler({
			store,
			timezone: 'UTC',
			runTask: async (task) => {
				const response = await agent.processMessage(task, 'api');
				return { success: true, output: response.content };
			},
		});
		const jobId = await scheduler.createJob({ schedule: '* * * * *', task: 'Run test job' });
		await scheduler.runJobNow(jobId);
		const scheduled = await scheduler.listJobs();
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.runCount).toBe(1);

		const heartbeat = createHeartbeat({
			intervalMinutes: 30,
			heartbeatFile: join(mamaHome, 'heartbeat.md'),
			runTask: async (prompt) => {
				const response = await agent.processMessage(prompt, 'api');
				return { success: true, output: response.content };
			},
			auditStore,
		});
		const heartbeatReport = await heartbeat.runOnce();
		expect(heartbeatReport.result.success).toBe(true);

		const daemon = createDaemonController({
			pidFile: join(mamaHome, 'mama.pid'),
			services: [
				{
					name: 'scheduler',
					start: async () => scheduler.start(),
					stop: async () => scheduler.stop(),
				},
				{
					name: 'heartbeat',
					start: async () => heartbeat.start(),
					stop: async () => heartbeat.stop(),
				},
			],
			healthCheckIntervalMs: 10_000,
		});
		await daemon.start();
		expect(existsSync(join(mamaHome, 'mama.pid'))).toBe(true);

		// 4/5) telegram channel can receive message and list jobs
		const sent: Array<{ chatId: number; text: string }> = [];
		const telegram = createTelegramChannel({
			token: 'token',
			allowedUserIds: [11],
			workspacePath: join(mamaHome, 'workspace'),
			agent,
			adapter: createMockAdapter(sent),
			scheduler,
			auditStore,
			memorySearch: async (query) => `memory:${query}`,
			costSnapshot: () => ({
				todayCostUsd: router.getCostTracker().getCostToday(),
				monthCostUsd: router.getCostTracker().getCostThisMonth(),
				totalCostUsd: router.getCostTracker().getTotalCost(),
			}),
		});
		await telegram.start();
		await telegram.handleIncoming({ chatId: 11, fromId: 11, text: 'hello from telegram' });
		await telegram.handleIncoming({ chatId: 11, fromId: 11, text: '/jobs' });
		expect(sent.some((entry) => entry.text.includes('hello from telegram'))).toBe(true);
		expect(sent.some((entry) => entry.text.includes(jobId))).toBe(true);

		// 6/7/8/9) heartbeat done, memory searchable, audit has entries, cost has records
		const semantic = await episodic.searchSemantic('test memory', { topK: 3 });
		expect(semantic.length).toBeGreaterThan(0);
		expect(auditStore.getRecent(20).length).toBeGreaterThan(0);
		expect(router.getCostTracker().getRecords().length).toBeGreaterThan(0);

		// 10) daemon stop cleanly
		await telegram.stop();
		await daemon.stop();
		expect(existsSync(join(mamaHome, 'mama.pid'))).toBe(false);
		store.close();
	});
});
