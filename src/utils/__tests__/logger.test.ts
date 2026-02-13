import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, initLogger, resetLogger } from '../logger.js';

const testDir = join(tmpdir(), 'mama-test-logger');
const testLogPath = join(testDir, 'test.log');

beforeEach(() => {
	mkdirSync(testDir, { recursive: true });
	resetLogger();
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	resetLogger();
});

describe('createLogger', () => {
	it('logs messages at correct levels to file', () => {
		initLogger({ level: 'debug', filePath: testLogPath, silent: true });

		const logger = createLogger('test-module');
		logger.info('hello world', { key: 'value' });

		const content = readFileSync(testLogPath, 'utf-8').trim();
		const entry = JSON.parse(content);

		expect(entry.level).toBe('info');
		expect(entry.module).toBe('test-module');
		expect(entry.message).toBe('hello world');
		expect(entry.key).toBe('value');
		expect(entry.timestamp).toBeDefined();
	});

	it('filters messages below configured level', () => {
		initLogger({ level: 'warn', filePath: testLogPath, silent: true });

		const logger = createLogger('test-module');
		logger.debug('should not appear');
		logger.info('should not appear');
		logger.warn('should appear');

		const content = readFileSync(testLogPath, 'utf-8').trim();
		const lines = content.split('\n');
		expect(lines).toHaveLength(1);

		const entry = JSON.parse(lines[0] ?? '');
		expect(entry.level).toBe('warn');
		expect(entry.message).toBe('should appear');
	});

	it('logs all levels when set to debug', () => {
		initLogger({ level: 'debug', filePath: testLogPath, silent: true });

		const logger = createLogger('test-module');
		logger.debug('d');
		logger.info('i');
		logger.warn('w');
		logger.error('e');

		const content = readFileSync(testLogPath, 'utf-8').trim();
		const lines = content.split('\n');
		expect(lines).toHaveLength(4);
	});

	it('produces valid JSON for each log entry', () => {
		initLogger({ level: 'debug', filePath: testLogPath, silent: true });

		const logger = createLogger('json-test');
		logger.info('structured', { count: 42, nested: { a: 1 } });

		const content = readFileSync(testLogPath, 'utf-8').trim();
		const entry = JSON.parse(content);

		expect(entry.count).toBe(42);
		expect(entry.nested).toEqual({ a: 1 });
	});

	it('includes timestamp in ISO format', () => {
		initLogger({ level: 'info', filePath: testLogPath, silent: true });

		const logger = createLogger('time-test');
		logger.info('ts test');

		const content = readFileSync(testLogPath, 'utf-8').trim();
		const entry = JSON.parse(content);

		// Should be a valid ISO date
		expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
	});
});
