import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsolidatedMemory } from '../consolidated.js';
import { createSoul } from '../soul.js';

const testDir = join(tmpdir(), 'mama-test-soul');

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('Soul', () => {
	it('returns default soul when file does not exist', () => {
		const soul = createSoul({
			soulPath: '/nonexistent/soul.md',
			userName: 'Alex',
			agentName: 'Mama',
		});

		const prompt = soul.getSoulPrompt();
		expect(prompt).toContain('Mama');
		expect(prompt).toContain('Alex');
		expect(prompt).toContain('Soul Definition');
	});

	it('loads soul from file and substitutes variables', () => {
		mkdirSync(testDir, { recursive: true });
		const soulPath = join(testDir, 'soul.md');
		writeFileSync(soulPath, '# Hello {userName}, I am {agentName}!');

		const soul = createSoul({
			soulPath,
			userName: 'TestUser',
			agentName: 'TestAgent',
		});

		const prompt = soul.getSoulPrompt();
		expect(prompt).toBe('# Hello TestUser, I am TestAgent!');
	});

	it('reloads soul from disk', () => {
		mkdirSync(testDir, { recursive: true });
		const soulPath = join(testDir, 'soul.md');
		writeFileSync(soulPath, 'Version 1');

		const soul = createSoul({
			soulPath,
			userName: 'Alex',
			agentName: 'Mama',
		});

		expect(soul.getSoulPrompt()).toBe('Version 1');

		writeFileSync(soulPath, 'Version 2');
		soul.reload();

		expect(soul.getSoulPrompt()).toBe('Version 2');
	});

	it('regenerates dynamic sections from consolidated memories', () => {
		mkdirSync(testDir, { recursive: true });
		const soulPath = join(testDir, 'soul.md');
		const soul = createSoul({
			soulPath,
			userName: 'Alex',
			agentName: 'Mama',
		});

		const memories: ConsolidatedMemory[] = [
			{
				id: 'm-1',
				createdAt: new Date('2026-02-10T00:00:00.000Z'),
				updatedAt: new Date('2026-02-11T00:00:00.000Z'),
				category: 'goal',
				content: 'Ship Task 3.4 this week',
				confidence: 0.9,
				sourceEpisodes: ['e-1'],
				embedding: null,
				active: true,
				reinforcementCount: 1,
				lastReinforcedAt: new Date('2026-02-11T00:00:00.000Z'),
				contradictions: [],
			},
			{
				id: 'm-2',
				createdAt: new Date('2026-02-10T00:00:00.000Z'),
				updatedAt: new Date('2026-02-11T00:00:00.000Z'),
				category: 'preference',
				content: 'User prefers concise technical updates',
				confidence: 0.8,
				sourceEpisodes: ['e-2'],
				embedding: null,
				active: true,
				reinforcementCount: 1,
				lastReinforcedAt: new Date('2026-02-11T00:00:00.000Z'),
				contradictions: [],
			},
		];

		soul.regenerateFromMemories(memories);
		const content = soul.getSoulPrompt();

		expect(content).toContain('## Knowledge');
		expect(content).toContain('## Active Goals');
		expect(content).toContain('## Preferences');
		expect(content).toContain('Ship Task 3.4 this week');
		expect(content).toContain('User prefers concise technical updates');
	});
});
