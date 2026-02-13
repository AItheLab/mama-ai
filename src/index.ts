#!/usr/bin/env node

import { join } from 'node:path';
import { Command } from 'commander';
import {
	createApiChannel,
	createTelegramChannel,
	createTelegramHttpAdapter,
	startTerminal,
} from './channels/index.js';
import { registerCostCommand } from './cli/cost.js';
import { registerInitCommand } from './cli/init.js';
import { registerJobsCommands } from './cli/jobs.js';
import { registerMemoryCommands } from './cli/memory.js';
import { ensureMamaHome, getConfig, initConfig, type MamaConfig } from './config/index.js';
import { createAgent } from './core/index.js';
import {
	createDaemonController,
	getDaemonStatus,
	type ManagedService,
	readDaemonLogs,
	startDetachedDaemonProcess,
	stopDaemonProcess,
} from './daemon.js';
import { createClaudeProvider, createLLMRouter, createOllamaProvider } from './llm/index.js';
import {
	createConsolidatedMemoryStore,
	createConsolidationEngine,
	createConsolidationScheduler,
	createDecayEngine,
	createEmbeddingService,
	createEpisodicMemory,
	createMemoryRetrievalPipeline,
	createMemoryStore,
	createSoul,
	createWorkingMemory,
} from './memory/index.js';
import {
	createAuditStore,
	createFsCapability,
	createNetworkCapability,
	createSandbox,
	createShellCapability,
} from './sandbox/index.js';
import {
	type CronScheduler,
	createCronScheduler,
	createHeartbeat,
	createTriggerEngine,
	setScheduler,
} from './scheduler/index.js';
import { createLogger, initLogger } from './utils/index.js';

const program = new Command();
const logger = createLogger('main');

interface RuntimeServices {
	router: ReturnType<typeof createLLMRouter>;
	soul: ReturnType<typeof createSoul>;
	memoryStore: ReturnType<typeof createMemoryStore>;
	episodicMemory: ReturnType<typeof createEpisodicMemory>;
	consolidatedMemory: ReturnType<typeof createConsolidatedMemoryStore>;
	retrieval: ReturnType<typeof createMemoryRetrievalPipeline>;
	consolidationEngine: ReturnType<typeof createConsolidationEngine>;
}

interface AppRuntime {
	config: MamaConfig;
	mamaHome: string;
	runtime: RuntimeServices;
	auditStore: ReturnType<typeof createAuditStore>;
	sandbox: ReturnType<typeof createSandbox>;
	createSessionAgent(): ReturnType<typeof createAgent>;
	close(): void;
}

function resolvePath(value: string, mamaHome: string): string {
	if (value === '~') return process.env.HOME ?? mamaHome;
	if (value.startsWith('~/')) {
		return value.replace('~', process.env.HOME ?? mamaHome);
	}
	return value;
}

function initAppConfig(configPath?: string): MamaConfig {
	const configResult = initConfig(configPath);
	if (!configResult.ok) {
		throw configResult.error;
	}
	return getConfig();
}

function createRuntimeServices(config: MamaConfig, mamaHome: string): RuntimeServices {
	const memoryStore = createMemoryStore();
	const claudeProvider = config.llm.providers.claude.apiKey
		? createClaudeProvider({
				apiKey: config.llm.providers.claude.apiKey,
				defaultModel: config.llm.providers.claude.defaultModel,
			})
		: undefined;
	const ollamaProvider = createOllamaProvider({
		host: config.llm.providers.ollama.host,
		apiKey: config.llm.providers.ollama.apiKey,
		defaultModel: config.llm.providers.ollama.defaultModel,
		embeddingModel: config.llm.providers.ollama.embeddingModel,
	});
	const router = createLLMRouter({
		config,
		claudeProvider,
		ollamaProvider,
		usageStore: memoryStore,
	});
	const embeddings = createEmbeddingService({
		embedder: (text) => ollamaProvider.embed(text),
	});
	const episodicMemory = createEpisodicMemory({
		store: memoryStore,
		embeddings,
		defaultTopK: config.memory.searchTopK,
	});
	const consolidatedMemory = createConsolidatedMemoryStore({
		store: memoryStore,
		embeddings,
		defaultTopK: config.memory.searchTopK,
	});
	const soul = createSoul({
		soulPath: resolvePath(config.agent.soulPath, mamaHome),
		userName: config.user.name,
		agentName: config.agent.name,
	});
	const decayEngine = createDecayEngine({
		store: memoryStore,
		consolidated: consolidatedMemory,
	});
	const retrieval = createMemoryRetrievalPipeline({
		store: memoryStore,
		episodic: episodicMemory,
		consolidated: consolidatedMemory,
		maxMemoryResults: 10,
		maxRecentEpisodes: 20,
		recentWindowHours: 24,
	});
	const consolidationEngine = createConsolidationEngine({
		router,
		store: memoryStore,
		episodic: episodicMemory,
		consolidated: consolidatedMemory,
		embeddings,
		soul,
		decay: decayEngine,
		minEpisodesToConsolidate: config.memory.consolidation.minEpisodesToConsolidate,
	});

	return {
		router,
		soul,
		memoryStore,
		episodicMemory,
		consolidatedMemory,
		retrieval,
		consolidationEngine,
	};
}

function createAppRuntime(configPath?: string, silentLogs = true): AppRuntime {
	const config = initAppConfig(configPath);
	const mamaHome = ensureMamaHome();
	initLogger({
		level: config.logging.level,
		filePath: resolvePath(config.logging.file, mamaHome),
		silent: silentLogs,
	});

	const runtime = createRuntimeServices(config, mamaHome);
	const auditStore = createAuditStore(join(mamaHome, 'mama.db'));
	const sandbox = createSandbox(auditStore);
	const homePath = process.env.HOME ?? mamaHome;

	sandbox.register(createFsCapability(config.sandbox.filesystem, homePath));
	sandbox.register(createShellCapability(config.sandbox.shell));
	sandbox.register(createNetworkCapability(config.sandbox.network));

	function createSessionAgent(): ReturnType<typeof createAgent> {
		return createAgent({
			router: runtime.router,
			workingMemory: createWorkingMemory({ maxTokens: 100000 }),
			soul: runtime.soul,
			sandbox,
			episodicMemory: runtime.episodicMemory,
			retrieval: runtime.retrieval,
			retrievalTokenBudget: 1200,
			maxIterations: 10,
		});
	}

	return {
		config,
		mamaHome,
		runtime,
		auditStore,
		sandbox,
		createSessionAgent,
		close() {
			setScheduler(null);
			auditStore.close();
			runtime.memoryStore.close();
		},
	};
}

function createNaturalScheduleParser(router: RuntimeServices['router']) {
	return {
		async parseNaturalLanguage(schedule: string): Promise<string | null> {
			const response = await router.complete({
				taskType: 'simple_tasks',
				maxTokens: 64,
				messages: [
					{
						role: 'user',
						content: [
							'Convert this natural schedule into a 5-field cron expression.',
							'Return only the cron expression or INVALID.',
							`Schedule: ${schedule}`,
						].join('\n'),
					},
				],
			});
			const line = response.content.trim().split('\n')[0]?.trim() ?? '';
			if (!line || line.toUpperCase().includes('INVALID')) return null;
			return line.match(/^(\S+\s){4}\S+$/)?.[0] ?? null;
		},
	};
}

async function createScheduler(
	app: AppRuntime,
	onRun?: (summary: string, priority?: 'low' | 'normal' | 'high' | 'urgent') => Promise<void>,
): Promise<CronScheduler> {
	const scheduler = await createCronScheduler({
		store: app.runtime.memoryStore,
		timezone: app.config.user.timezone,
		parser: createNaturalScheduleParser(app.runtime.router),
		auditStore: app.auditStore,
		runTask: async (task, context) => {
			try {
				const response = await app.createSessionAgent().processMessage(task, 'api');
				await onRun?.(`Job "${context.jobName}" executed.\n${response.content}`, 'normal');
				return {
					success: true,
					output: {
						content: response.content,
						model: response.model,
						provider: response.provider,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await onRun?.(`Job "${context.jobName}" failed: ${message}`, 'high');
				return { success: false, error: message };
			}
		},
	});
	return scheduler;
}

function createMemorySearch(app: AppRuntime) {
	return async (query: string): Promise<string> => {
		const [memories, episodes] = await Promise.all([
			app.runtime.consolidatedMemory.search(query, {
				topK: 5,
				includeInactive: true,
				minConfidence: 0,
			}),
			app.runtime.episodicMemory.searchSemantic(query, { topK: 5 }),
		]);
		return [
			`Memory search: "${query}"`,
			'',
			'Consolidated:',
			...memories.map((m) => `- [${m.category}] ${m.content}`),
			'',
			'Episodic:',
			...episodes.map((e) => `- (${e.role}) ${e.content}`),
		]
			.filter(Boolean)
			.join('\n');
	};
}

function createCostSnapshot(app: AppRuntime) {
	return () => {
		const tracker = app.runtime.router.getCostTracker();
		return {
			todayCostUsd: tracker.getCostToday(),
			monthCostUsd: tracker.getCostThisMonth(),
			totalCostUsd: tracker.getTotalCost(),
			records: tracker.getRecords().length,
		};
	};
}

async function runChat(configPath?: string): Promise<void> {
	const app = createAppRuntime(configPath, true);
	logger.info('Mama starting', { version: '0.1.0' });

	const workingMemory = createWorkingMemory({ maxTokens: 100000 });
	const agent = createAgent({
		router: app.runtime.router,
		workingMemory,
		soul: app.runtime.soul,
		sandbox: app.sandbox,
		episodicMemory: app.runtime.episodicMemory,
		retrieval: app.runtime.retrieval,
		retrievalTokenBudget: 1200,
		maxIterations: 10,
	});
	let lastInteractionAt = Date.now();
	const trackedAgent: ReturnType<typeof createAgent> = {
		...agent,
		async processMessage(input, channel, options) {
			lastInteractionAt = Date.now();
			return agent.processMessage(input, channel, options);
		},
	};

	const scheduler = await createScheduler(app);
	await scheduler.start();
	setScheduler(scheduler);

	const cleanup = () => {
		scheduler.stop();
		app.close();
	};
	process.on('exit', cleanup);
	process.on('SIGTERM', () => {
		cleanup();
		process.exit(0);
	});

	const consolidation = createConsolidationScheduler({
		engine: app.runtime.consolidationEngine,
		intervalHours: app.config.memory.consolidation.intervalHours,
		minEpisodesToConsolidate: app.config.memory.consolidation.minEpisodesToConsolidate,
		isIdle: () => Date.now() - lastInteractionAt > 60_000,
		onReport: (report) => {
			if (!report.skipped) logger.info('Consolidation completed', { report });
		},
	});
	if (app.config.memory.consolidation.enabled) {
		consolidation.start();
	}
	process.on('exit', () => consolidation.stop());

	startTerminal(trackedAgent, app.config.agent.name, app.sandbox);
}

async function runDaemonForeground(configPath?: string): Promise<void> {
	const app = createAppRuntime(configPath, false);
	const memorySearch = createMemorySearch(app);
	const costSnapshot = createCostSnapshot(app);
	let telegramChannel: ReturnType<typeof createTelegramChannel> | null = null;

	const notify = async (
		text: string,
		priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal',
	): Promise<void> => {
		const chatId = app.config.channels.telegram.defaultChatId;
		if (!telegramChannel || !chatId || chatId <= 0) return;
		await telegramChannel.sendProactiveMessage(chatId, text, priority);
	};

	const scheduler = await createScheduler(app, notify);
	const heartbeat = createHeartbeat({
		intervalMinutes: app.config.scheduler.heartbeat.intervalMinutes,
		heartbeatFile: resolvePath(app.config.scheduler.heartbeat.heartbeatFile, app.mamaHome),
		auditStore: app.auditStore,
		runTask: async (prompt) => {
			const response = await app.createSessionAgent().processMessage(prompt, 'api');
			await notify(`Heartbeat run completed.\n${response.content}`, 'low');
			return {
				success: true,
				output: response.content,
			};
		},
	});
	const triggers = createTriggerEngine({
		fileWatchers: app.config.scheduler.triggers.fileWatchers,
		webhooks: app.config.scheduler.triggers.webhooks,
		runTask: async (task) => {
			await app.createSessionAgent().processMessage(task, 'api');
			return { success: true };
		},
	});

	const services: ManagedService[] = [
		{
			name: 'scheduler',
			start: async () => {
				await scheduler.start();
				setScheduler(scheduler);
			},
			stop: async () => {
				scheduler.stop();
				setScheduler(null);
			},
			healthCheck: async () => true,
		},
	];

	if (app.config.scheduler.heartbeat.enabled) {
		services.push({
			name: 'heartbeat',
			start: async () => heartbeat.start(),
			stop: async () => heartbeat.stop(),
			healthCheck: async () => heartbeat.isRunning(),
		});
	}

	if (
		app.config.scheduler.triggers.fileWatchers.length > 0 ||
		app.config.scheduler.triggers.webhooks.enabled
	) {
		services.push({
			name: 'triggers',
			start: async () => triggers.start(),
			stop: async () => triggers.stop(),
			healthCheck: async () => true,
		});
	}

	if (app.config.channels.telegram.enabled && app.config.channels.telegram.botToken) {
		telegramChannel = createTelegramChannel({
			token: app.config.channels.telegram.botToken,
			allowedUserIds: app.config.user.telegramIds,
			workspacePath: resolvePath(app.config.sandbox.filesystem.workspace, app.mamaHome),
			agent: app.createSessionAgent(),
			adapter: createTelegramHttpAdapter(app.config.channels.telegram.botToken),
			sandbox: app.sandbox,
			scheduler,
			auditStore: app.auditStore,
			memorySearch,
			costSnapshot,
			statusSnapshot: async () => `running | jobs=${(await scheduler.listJobs()).length}`,
		});
		services.push({
			name: 'telegram',
			start: async () => telegramChannel?.start(),
			stop: async () => telegramChannel?.stop(),
			healthCheck: async () => true,
		});
	}

	if (app.config.channels.api.enabled) {
		const apiChannel = createApiChannel({
			host: app.config.channels.api.host,
			port: app.config.channels.api.port,
			token: app.config.channels.api.token,
			agent: app.createSessionAgent(),
			scheduler,
			auditStore: app.auditStore,
			memorySearch,
			costSnapshot,
			statusSnapshot: async () => ({
				status: 'running',
				jobs: (await scheduler.listJobs()).length,
			}),
		});
		services.push({
			name: 'api',
			start: async () => apiChannel.start(),
			stop: async () => apiChannel.stop(),
			healthCheck: async () => true,
		});
	}

	const daemon = createDaemonController({
		pidFile: resolvePath(app.config.daemon.pidFile, app.mamaHome),
		services,
		healthCheckIntervalMs: app.config.daemon.healthCheckIntervalSeconds * 1000,
	});

	await daemon.start();
	logger.info('Daemon started', {
		services: services.map((service) => service.name),
	});

	const shutdown = async () => {
		await daemon.stop();
		app.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());
	await new Promise<void>(() => undefined);
}

program.name('mama').description('Mama — Personal AI Agent').version('0.1.0');

program
	.command('chat')
	.description('Start interactive chat with Mama')
	.option('-c, --config <path>', 'Path to config file')
	.action(async (options: { config?: string }) => {
		try {
			await runChat(options.config);
		} catch (error) {
			process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	});

const daemonCommand = program
	.command('daemon')
	.description('Run Mama in headless daemon mode')
	.option('-c, --config <path>', 'Path to config file')
	.option('--foreground', 'Run in foreground process');

daemonCommand.action(async (options: { config?: string }) => {
	try {
		await runDaemonForeground(options.config);
	} catch (error) {
		process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
});

daemonCommand
	.command('start')
	.option('-c, --config <path>', 'Path to config file')
	.description('Start daemon as background process')
	.action((options: { config?: string }) => {
		const config = initAppConfig(options.config);
		const mamaHome = ensureMamaHome();
		const pidFile = resolvePath(config.daemon.pidFile, mamaHome);
		const status = getDaemonStatus(pidFile);
		if (status.running) {
			process.stdout.write(`Daemon already running (pid ${status.pid})\n`);
			return;
		}
		const args = [process.argv[1] ?? 'dist/index.js', 'daemon', '--foreground'];
		if (options.config) {
			args.push('--config', options.config);
		}
		const pid = startDetachedDaemonProcess({
			command: process.execPath,
			args,
			cwd: process.cwd(),
		});
		process.stdout.write(`Daemon started (pid ${pid}).\n`);
	});

daemonCommand
	.command('stop')
	.option('-c, --config <path>', 'Path to config file')
	.description('Stop daemon process')
	.action((options: { config?: string }) => {
		const config = initAppConfig(options.config);
		const mamaHome = ensureMamaHome();
		const pidFile = resolvePath(config.daemon.pidFile, mamaHome);
		const stopped = stopDaemonProcess(pidFile);
		process.stdout.write(stopped ? 'Stop signal sent.\n' : 'Daemon is not running.\n');
	});

daemonCommand
	.command('status')
	.option('-c, --config <path>', 'Path to config file')
	.description('Check daemon status')
	.action((options: { config?: string }) => {
		const config = initAppConfig(options.config);
		const mamaHome = ensureMamaHome();
		const pidFile = resolvePath(config.daemon.pidFile, mamaHome);
		const status = getDaemonStatus(pidFile);
		process.stdout.write(status.running ? `running (pid ${status.pid})\n` : 'not running\n');
	});

daemonCommand
	.command('logs')
	.option('-c, --config <path>', 'Path to config file')
	.option('-n, --lines <n>', 'Number of lines', (value: string) => Number.parseInt(value, 10), 100)
	.description('Show daemon logs')
	.action((options: { config?: string; lines: number }) => {
		const config = initAppConfig(options.config);
		const mamaHome = ensureMamaHome();
		const logs = readDaemonLogs(resolvePath(config.logging.file, mamaHome), options.lines);
		process.stdout.write(`${logs}\n`);
	});

registerMemoryCommands(program, {
	async resolveServices(configPath?: string) {
		const app = createAppRuntime(configPath, true);
		return {
			store: app.runtime.memoryStore,
			episodic: app.runtime.episodicMemory,
			consolidated: app.runtime.consolidatedMemory,
			consolidation: app.runtime.consolidationEngine,
			close() {
				app.close();
			},
		};
	},
});

registerJobsCommands(program, {
	async resolveScheduler(configPath?: string) {
		const app = createAppRuntime(configPath, true);
		const scheduler = await createScheduler(app);
		setScheduler(scheduler);
		return {
			scheduler,
			close() {
				scheduler.stop();
				app.close();
			},
		};
	},
});

registerCostCommand(program, {
	async resolveTracker(configPath?: string) {
		const app = createAppRuntime(configPath, true);
		return {
			tracker: app.runtime.router.getCostTracker(),
			close() {
				app.close();
			},
		};
	},
});

registerInitCommand(program);

program.action(() => {
	program.commands.find((command) => command.name() === 'chat')?.parse(process.argv);
});

program.parse();
