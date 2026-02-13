import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../init.js';

const tempRoots: string[] = [];
const originalMamaHome = process.env.MAMA_HOME;

function createTempHome(): string {
	const root = mkdtempSync(join(tmpdir(), 'mama-init-test-'));
	tempRoots.push(root);
	return root;
}

beforeEach(() => {
	process.env.MAMA_HOME = createTempHome();
});

afterEach(() => {
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

describe('runInit', () => {
	it('creates config, soul, heartbeat and workspace structure', async () => {
		const result = await runInit({
			name: 'Alex',
			telegramToken: 'tg-token',
			claudeApiKey: 'claude-key',
			yes: true,
		});

		expect(existsSync(result.configPath)).toBe(true);
		expect(existsSync(join(result.mamaHome, 'soul.md'))).toBe(true);
		expect(existsSync(join(result.mamaHome, 'heartbeat.md'))).toBe(true);
		expect(existsSync(join(result.mamaHome, 'workspace'))).toBe(true);

		const config = readFileSync(result.configPath, 'utf-8');
		expect(config).toContain('name: Alex');
		expect(config).toContain('bot_token: tg-token');
		expect(config).toContain('api_key: claude-key');
	});
});
