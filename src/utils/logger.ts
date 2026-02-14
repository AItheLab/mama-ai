import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogLevel } from '../config/schema.js';
import { redactSecretsInValue } from './secret-redaction.js';

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

interface LogEntry {
	timestamp: string;
	level: LogLevel;
	module: string;
	message: string;
	[key: string]: unknown;
}

interface LoggerOptions {
	level: LogLevel;
	filePath?: string;
	silent?: boolean;
}

interface Logger {
	debug: (message: string, context?: Record<string, unknown>) => void;
	info: (message: string, context?: Record<string, unknown>) => void;
	warn: (message: string, context?: Record<string, unknown>) => void;
	error: (message: string, context?: Record<string, unknown>) => void;
}

let _globalOptions: LoggerOptions = { level: 'info' };

/**
 * Initializes global logger settings. Call once at startup.
 */
export function initLogger(options: LoggerOptions): void {
	_globalOptions = options;
	if (options.filePath) {
		const dir = dirname(options.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}

function shouldLog(level: LogLevel): boolean {
	return LOG_LEVELS[level] >= LOG_LEVELS[_globalOptions.level];
}

function formatForStderr(entry: LogEntry): string {
	const { timestamp, level, module, message, ...rest } = entry;
	const time = timestamp.split('T')[1]?.replace('Z', '') ?? timestamp;
	const prefix = `${time} [${level.toUpperCase().padEnd(5)}] [${module}]`;
	const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
	return `${prefix} ${message}${extra}`;
}

function writeLog(entry: LogEntry): void {
	const safeEntry = redactSecretsInValue(entry) as LogEntry;

	// Write JSON to file
	if (_globalOptions.filePath) {
		try {
			appendFileSync(_globalOptions.filePath, `${JSON.stringify(safeEntry)}\n`);
		} catch {
			// Silently fail file logging — don't crash the agent
		}
	}

	// Pretty print to stderr (unless silent)
	if (!_globalOptions.silent) {
		const formatted = formatForStderr(safeEntry);
		process.stderr.write(`${formatted}\n`);
	}
}

/**
 * Creates a scoped logger for a specific module.
 */
export function createLogger(moduleName: string): Logger {
	function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		if (!shouldLog(level)) return;

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			module: moduleName,
			message,
			...context,
		};

		writeLog(entry);
	}

	return {
		debug: (message, context) => log('debug', message, context),
		info: (message, context) => log('info', message, context),
		warn: (message, context) => log('warn', message, context),
		error: (message, context) => log('error', message, context),
	};
}

/**
 * Resets logger to defaults (for testing).
 */
export function resetLogger(): void {
	_globalOptions = { level: 'info' };
}
