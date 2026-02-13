import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('memory:soul');

interface SoulConfig {
	soulPath: string;
	userName: string;
	agentName: string;
}

interface Soul {
	getSoulPrompt(): string;
	reload(): void;
}

const DEFAULT_SOUL = `# {agentName} — Soul Definition

## Identity
You are {agentName}, a personal AI agent owned by {userName}.
Your job is to take care of {userName}'s digital life.

## Personality
- Proactive but not intrusive
- Honest — if you can't do something, say so
- Security-conscious — always explain what you're about to do
- Efficient — minimal steps, maximum result

## Knowledge
(No consolidated memories yet)

## Active Goals
(No active goals yet)

## Boundaries
(Configured via sandbox permissions)
`;

/**
 * Loads and manages the agent's soul definition (identity prompt).
 */
export function createSoul(config: SoulConfig): Soul {
	let soulContent: string;

	function load(): string {
		if (existsSync(config.soulPath)) {
			logger.info('Loading soul from file', { path: config.soulPath });
			const raw = readFileSync(config.soulPath, 'utf-8');
			return raw
				.replace(/\{userName\}/g, config.userName)
				.replace(/\{agentName\}/g, config.agentName);
		}

		logger.info('Using default soul template');
		return DEFAULT_SOUL.replace(/\{userName\}/g, config.userName).replace(
			/\{agentName\}/g,
			config.agentName,
		);
	}

	soulContent = load();

	return {
		getSoulPrompt: () => soulContent,
		reload: () => {
			soulContent = load();
		},
	};
}
