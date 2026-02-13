import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { getDefaultConfigPath, getMamaHome } from './defaults.js';
import { ConfigSchema, type MamaConfig } from './schema.js';

type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Resolves environment variable references in config values.
 * Supports ${ENV_VAR} syntax. Returns the value unchanged if not a reference.
 */
function resolveEnvVars(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
			const envValue = process.env[varName];
			if (envValue === undefined) {
				return '';
			}
			return envValue;
		});
	}
	if (Array.isArray(value)) {
		return value.map(resolveEnvVars);
	}
	if (value !== null && typeof value === 'object') {
		return resolveEnvVarsInObject(value as Record<string, unknown>);
	}
	return value;
}

function resolveEnvVarsInObject(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(obj)) {
		result[key] = resolveEnvVars(val);
	}
	return result;
}

/**
 * Converts YAML snake_case keys to camelCase for TypeScript config.
 */
function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function convertKeysToCamelCase(obj: unknown): unknown {
	if (Array.isArray(obj)) {
		return obj.map(convertKeysToCamelCase);
	}
	if (obj !== null && typeof obj === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
			result[snakeToCamel(key)] = convertKeysToCamelCase(val);
		}
		return result;
	}
	return obj;
}

/**
 * Loads and validates the Mama configuration.
 * Looks for config at the given path, or falls back to defaults.
 */
export function loadConfig(configPath?: string): Result<MamaConfig> {
	const path = configPath ?? getDefaultConfigPath();

	let rawConfig: Record<string, unknown> = {};

	if (existsSync(path)) {
		try {
			const content = readFileSync(path, 'utf-8');
			const parsed = parseYaml(content) as unknown;
			if (parsed !== null && typeof parsed === 'object') {
				rawConfig = parsed as Record<string, unknown>;
			}
		} catch (err) {
			return {
				ok: false,
				error: new Error(
					`Failed to parse config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
				),
			};
		}
	}

	// Convert YAML snake_case to camelCase
	const camelConfig = convertKeysToCamelCase(rawConfig) as Record<string, unknown>;

	// Resolve environment variable references
	const resolvedConfig = resolveEnvVarsInObject(camelConfig);

	// Validate with Zod
	const result = ConfigSchema.safeParse(resolvedConfig);

	if (!result.success) {
		const issues = result.error.issues.map(
			(issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
		);
		return {
			ok: false,
			error: new Error(`Invalid configuration:\n${issues.join('\n')}`),
		};
	}

	return { ok: true, value: result.data };
}

/**
 * Ensures the Mama home directory exists.
 */
export function ensureMamaHome(): string {
	const home = getMamaHome();
	if (!existsSync(home)) {
		mkdirSync(home, { recursive: true });
	}
	const logsDir = `${home}/logs`;
	if (!existsSync(logsDir)) {
		mkdirSync(logsDir, { recursive: true });
	}
	return home;
}

// Singleton config holder
let _config: MamaConfig | null = null;

/**
 * Initializes and returns the config. Call once at startup.
 */
export function initConfig(configPath?: string): Result<MamaConfig> {
	const result = loadConfig(configPath);
	if (result.ok) {
		_config = result.value;
	}
	return result;
}

/**
 * Gets the loaded config. Throws if not initialized.
 */
export function getConfig(): MamaConfig {
	if (_config === null) {
		throw new Error('Config not initialized. Call initConfig() first.');
	}
	return _config;
}

/**
 * Resets config (for testing).
 */
export function resetConfig(): void {
	_config = null;
}
