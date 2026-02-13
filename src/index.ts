#!/usr/bin/env node

/**
 * Mama — Personal AI Agent
 * Entry point
 */

import { join } from 'node:path';
import { Command } from 'commander';
import { startTerminal } from './channels/terminal.js';
import { registerMemoryCommands } from './cli/memory.js';
import { ensureMamaHome, getConfig, initConfig, type MamaConfig } from './config/index.js';
import { createAgent } from './core/index.js';
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
import { createLogger, initLogger } from './utils/index.js';

const program = new Command();

interface RuntimeServices {
	router: ReturnType<typeof createLLMRouter>;
	soul: ReturnType<typeof createSoul>;
	memoryStore: ReturnType<typeof createMemoryStore>;
	episodicMemory: ReturnType<typeof createEpisodicMemory>;
	consolidatedMemory: ReturnType<typeof createConsolidatedMemoryStore>;
	retrieval: ReturnType<typeof createMemoryRetrievalPipeline>;
	consolidationEngine: ReturnType<typeof createConsolidationEngine>;
}

function createRuntimeServices(config: MamaConfig): RuntimeServices {
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
	});

	const memoryStore = createMemoryStore();
	const embeddingService = createEmbeddingService({
		embedder: (text) => ollamaProvider.embed(text),
	});
	const episodicMemory = createEpisodicMemory({
		store: memoryStore,
		embeddings: embeddingService,
		defaultTopK: config.memory.searchTopK,
	});
	const consolidatedMemory = createConsolidatedMemoryStore({
		store: memoryStore,
		embeddings: embeddingService,
		defaultTopK: config.memory.searchTopK,
	});
	const soul = createSoul({
		soulPath: config.agent.soulPath.replace('~', process.env.HOME ?? ''),
		userName: config.user.name,
		agentName: config.agent.name,
	});
	const decayEngine = createDecayEngine({
		store: memoryStore,
		consolidated: consolidatedMemory,
	});
	const consolidationEngine = createConsolidationEngine({
		router,
		store: memoryStore,
		episodic: episodicMemory,
		consolidated: consolidatedMemory,
		embeddings: embeddingService,
		soul,
		decay: decayEngine,
		minEpisodesToConsolidate: config.memory.consolidation.minEpisodesToConsolidate,
	});
	const retrieval = createMemoryRetrievalPipeline({
		store: memoryStore,
		episodic: episodicMemory,
		consolidated: consolidatedMemory,
		maxMemoryResults: 10,
		maxRecentEpisodes: 20,
		recentWindowHours: 24,
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

function initAppConfig(configPath?: string): MamaConfig {
	const configResult = initConfig(configPath);
	if (!configResult.ok) {
		throw configResult.error;
	}
	return getConfig();
}

program.name('mama').description('Mama — Personal AI Agent').version('0.1.0');

program
	.command('chat')
	.description('Start interactive chat with Mama')
	.option('-c, --config <path>', 'Path to config file')
	.action(async (options: { config?: string }) => {
		// 1. Load config
		let config: MamaConfig;
		try {
			config = initAppConfig(options.config);
		} catch (error) {
			process.stderr.write(
				`Config error: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
			return;
		}
		const mamaHome = ensureMamaHome();

		// 2. Init logger
		initLogger({
			level: config.logging.level,
			filePath: config.logging.file.replace('~', process.env.HOME ?? ''),
			silent: true, // Don't pollute terminal with logs in chat mode
		});

		const logger = createLogger('main');
		logger.info('Mama starting', { version: '0.1.0' });

		// 3. Create LLM + memory runtime
		const runtime = createRuntimeServices(config);

		// 4. Create working memory
		const workingMemory = createWorkingMemory({ maxTokens: 100000 });

		// 5. Create agent
		const auditStore = createAuditStore(join(mamaHome, 'mama.db'));
		const sandbox = createSandbox(auditStore);
		const homePath = process.env.HOME ?? mamaHome;

		sandbox.register(createFsCapability(config.sandbox.filesystem, homePath));
		sandbox.register(createShellCapability(config.sandbox.shell));
		sandbox.register(createNetworkCapability(config.sandbox.network));

		const agent = createAgent({
			router: runtime.router,
			workingMemory,
			soul: runtime.soul,
			sandbox,
			episodicMemory: runtime.episodicMemory,
			retrieval: runtime.retrieval,
			retrievalTokenBudget: 1200,
			maxIterations: 10,
		});
		let lastInteractionAt = Date.now();
		const trackedAgent: ReturnType<typeof createAgent> = {
			...agent,
			async processMessage(input, channel, runOptions) {
				lastInteractionAt = Date.now();
				return agent.processMessage(input, channel, runOptions);
			},
		};

		const consolidationScheduler = createConsolidationScheduler({
			engine: runtime.consolidationEngine,
			intervalHours: config.memory.consolidation.intervalHours,
			minEpisodesToConsolidate: config.memory.consolidation.minEpisodesToConsolidate,
			isIdle: () => Date.now() - lastInteractionAt > 60_000,
			onReport: (report) => {
				if (!report.skipped) {
					logger.info('Memory consolidation cycle completed', { ...report });
				}
			},
		});
		if (config.memory.consolidation.enabled) {
			consolidationScheduler.start();
		}
		process.on('exit', () => consolidationScheduler.stop());

		// 7. Start terminal
		logger.info('Starting terminal channel');
		startTerminal(trackedAgent, config.agent.name, sandbox);
	});

registerMemoryCommands(program, {
	async resolveServices(configPath?: string) {
		const config = initAppConfig(configPath);
		ensureMamaHome();
		initLogger({
			level: config.logging.level,
			filePath: config.logging.file.replace('~', process.env.HOME ?? ''),
			silent: true,
		});
		const runtime = createRuntimeServices(config);
		return {
			store: runtime.memoryStore,
			episodic: runtime.episodicMemory,
			consolidated: runtime.consolidatedMemory,
			consolidation: runtime.consolidationEngine,
			close() {
				runtime.memoryStore.close();
			},
		};
	},
});

// Default command is chat
program.action(() => {
	program.commands.find((c) => c.name() === 'chat')?.parse(process.argv);
});

program.parse();
