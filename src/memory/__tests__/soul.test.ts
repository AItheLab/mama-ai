import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
});
