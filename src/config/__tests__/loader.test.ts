import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, initConfig, loadConfig, resetConfig } from '../loader.js';

const testDir = join(tmpdir(), 'mama-test-config');
const testConfigPath = join(testDir, 'config.yaml');

beforeEach(() => {
	mkdirSync(testDir, { recursive: true });
	resetConfig();
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	resetConfig();
});

describe('loadConfig', () => {
	it('returns defaults when config file does not exist', () => {
		const result = loadConfig('/nonexistent/config.yaml');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.version).toBe(1);
			expect(result.value.agent.name).toBe('Mama');
			expect(result.value.llm.defaultProvider).toBe('claude');
			expect(result.value.logging.level).toBe('info');
		}
	});

	it('loads and validates a valid YAML config', () => {
		writeFileSync(
			testConfigPath,
			`
version: 1
agent:
  name: "TestMama"
user:
  name: "TestUser"
  timezone: "America/New_York"
logging:
  level: "debug"
`,
		);

		const result = loadConfig(testConfigPath);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.agent.name).toBe('TestMama');
			expect(result.value.user.name).toBe('TestUser');
			expect(result.value.user.timezone).toBe('America/New_York');
			expect(result.value.logging.level).toBe('debug');
		}
	});

	it('resolves environment variable references', () => {
		process.env.TEST_MAMA_API_KEY = 'sk-test-12345';

		writeFileSync(
			testConfigPath,
			`
version: 1
llm:
  providers:
    claude:
      api_key: "\${TEST_MAMA_API_KEY}"
`,
		);

		const result = loadConfig(testConfigPath);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.llm.providers.claude.apiKey).toBe('sk-test-12345');
		}

		delete process.env.TEST_MAMA_API_KEY;
	});

	it('replaces undefined env vars with empty string', () => {
		writeFileSync(
			testConfigPath,
			`
version: 1
llm:
  providers:
    claude:
      api_key: "\${NONEXISTENT_VAR}"
`,
		);

		const result = loadConfig(testConfigPath);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.llm.providers.claude.apiKey).toBe('');
		}
	});

	it('returns error for invalid YAML syntax', () => {
		writeFileSync(testConfigPath, '{{invalid yaml:::');

		const result = loadConfig(testConfigPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain('Failed to parse config');
		}
	});

	it('returns error for invalid config values', () => {
		writeFileSync(
			testConfigPath,
			`
version: 1
channels:
  api:
    port: 99999
`,
		);

		const result = loadConfig(testConfigPath);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain('Invalid configuration');
		}
	});

	it('converts snake_case keys to camelCase', () => {
		writeFileSync(
			testConfigPath,
			`
version: 1
llm:
  default_provider: "ollama"
  providers:
    claude:
      default_model: "claude-opus-4-20250514"
      max_monthly_budget_usd: 100
`,
		);

		const result = loadConfig(testConfigPath);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.llm.defaultProvider).toBe('ollama');
			expect(result.value.llm.providers.claude.defaultModel).toBe('claude-opus-4-20250514');
			expect(result.value.llm.providers.claude.maxMonthlyBudgetUsd).toBe(100);
		}
	});
});

describe('initConfig / getConfig', () => {
	it('initializes and retrieves config', () => {
		const result = initConfig('/nonexistent/config.yaml');
		expect(result.ok).toBe(true);

		const config = getConfig();
		expect(config.agent.name).toBe('Mama');
	});

	it('throws if getConfig called before init', () => {
		expect(() => getConfig()).toThrow('Config not initialized');
	});
});
