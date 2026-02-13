#!/usr/bin/env node

/**
 * Mama — Personal AI Agent
 * Entry point
 */

import { Command } from 'commander';
import { startTerminal } from './channels/terminal.js';
import { getConfig, initConfig } from './config/index.js';
import { createAgent } from './core/index.js';
import { createClaudeProvider, createLLMRouter, createOllamaProvider } from './llm/index.js';
import { createSoul, createWorkingMemory } from './memory/index.js';
import { createLogger, initLogger } from './utils/index.js';

const program = new Command();

program.name('mama').description('Mama — Personal AI Agent').version('0.1.0');

program
	.command('chat')
	.description('Start interactive chat with Mama')
	.option('-c, --config <path>', 'Path to config file')
	.action(async (options: { config?: string }) => {
		// 1. Load config
		const configResult = initConfig(options.config);
		if (!configResult.ok) {
			process.stderr.write(`Config error: ${configResult.error.message}\n`);
			process.exit(1);
		}
		const config = getConfig();

		// 2. Init logger
		initLogger({
			level: config.logging.level,
			filePath: config.logging.file.replace('~', process.env.HOME ?? ''),
			silent: true, // Don't pollute terminal with logs in chat mode
		});

		const logger = createLogger('main');
		logger.info('Mama starting', { version: '0.1.0' });

		// 3. Create LLM providers
		const claudeProvider = config.llm.providers.claude.apiKey
			? createClaudeProvider({
					apiKey: config.llm.providers.claude.apiKey,
					defaultModel: config.llm.providers.claude.defaultModel,
				})
			: undefined;

		const ollamaProvider = createOllamaProvider({
			host: config.llm.providers.ollama.host,
			defaultModel: config.llm.providers.ollama.defaultModel,
			embeddingModel: config.llm.providers.ollama.embeddingModel,
		});

		// 4. Create router
		const router = createLLMRouter({
			config,
			claudeProvider,
			ollamaProvider,
		});

		// 5. Create memory
		const workingMemory = createWorkingMemory({ maxTokens: 100000 });
		const soul = createSoul({
			soulPath: config.agent.soulPath.replace('~', process.env.HOME ?? ''),
			userName: config.user.name,
			agentName: config.agent.name,
		});

		// 6. Create agent
		const agent = createAgent({ router, workingMemory, soul });

		// 7. Start terminal
		logger.info('Starting terminal channel');
		startTerminal(agent, config.agent.name);
	});

// Default command is chat
program.action(() => {
	program.commands.find((c) => c.name() === 'chat')?.parse(process.argv);
});

program.parse();
