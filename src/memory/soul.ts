import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { ConsolidatedMemory } from './consolidated.js';

const logger = createLogger('memory:soul');

interface SoulConfig {
	soulPath: string;
	userName: string;
	agentName: string;
}

interface Soul {
	getSoulPrompt(): string;
	reload(): void;
	regenerateFromMemories(memories: ConsolidatedMemory[]): void;
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

## Preferences
(No learned preferences yet)

## Boundaries
(Configured via sandbox permissions)
`;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueByContent(memories: ConsolidatedMemory[]): ConsolidatedMemory[] {
	const seen = new Set<string>();
	const result: ConsolidatedMemory[] = [];
	for (const memory of memories) {
		const key = memory.content.trim().toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(memory);
	}
	return result;
}

function upsertSection(document: string, title: string, body: string): string {
	const sectionHeader = `## ${title}`;
	const sectionText = `${sectionHeader}\n${body}`;
	const pattern = new RegExp(`## ${escapeRegExp(title)}\\n[\\s\\S]*?(?=\\n## |$)`, 'm');

	if (pattern.test(document)) {
		return document.replace(pattern, sectionText);
	}

	const trimmed = document.trimEnd();
	return `${trimmed}\n\n${sectionText}\n`;
}

function toBulletedList(memories: ConsolidatedMemory[], emptyLabel: string): string {
	if (memories.length === 0) return emptyLabel;
	return memories
		.map((memory) => `- ${memory.content} (confidence ${memory.confidence.toFixed(2)})`)
		.join('\n');
}

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
		regenerateFromMemories(memories: ConsolidatedMemory[]): void {
			const activeMemories = uniqueByContent(
				memories
					.filter((memory) => memory.active)
					.sort(
						(a, b) => b.confidence - a.confidence || b.updatedAt.getTime() - a.updatedAt.getTime(),
					),
			);

			const knowledge = activeMemories.filter((memory) =>
				['fact', 'pattern', 'relationship', 'skill', 'project'].includes(memory.category),
			);
			const goals = activeMemories.filter((memory) => memory.category === 'goal');
			const preferences = activeMemories.filter((memory) =>
				['preference', 'routine', 'emotional'].includes(memory.category),
			);

			let nextSoul = soulContent;
			nextSoul = upsertSection(
				nextSoul,
				'Knowledge',
				toBulletedList(knowledge.slice(0, 12), '(No consolidated memories yet)'),
			);
			nextSoul = upsertSection(
				nextSoul,
				'Active Goals',
				toBulletedList(goals.slice(0, 8), '(No active goals yet)'),
			);
			nextSoul = upsertSection(
				nextSoul,
				'Preferences',
				toBulletedList(preferences.slice(0, 8), '(No learned preferences yet)'),
			);

			mkdirSync(dirname(config.soulPath), { recursive: true });
			writeFileSync(config.soulPath, nextSoul, 'utf-8');
			soulContent = nextSoul;
			logger.info('Soul regenerated from consolidated memories', {
				path: config.soulPath,
				totalMemories: activeMemories.length,
			});
		},
	};
}
