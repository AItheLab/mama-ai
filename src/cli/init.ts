import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getDefaultConfigPath, getMamaHome } from '../config/defaults.js';

interface InitAnswers {
	name: string;
	claudeApiKey: string;
	telegramToken: string;
}

interface InitOptions {
	name?: string;
	claudeApiKey?: string;
	telegramToken?: string;
	yes?: boolean;
	force?: boolean;
}

interface RunInitResult {
	mamaHome: string;
	configPath: string;
}

function resolveTemplatePath(name: string): string {
	return join(process.cwd(), 'templates', name);
}

function ensureMamaStructure(mamaHome: string): void {
	for (const dir of ['logs', 'workspace', 'notes', 'skills']) {
		mkdirSync(join(mamaHome, dir), { recursive: true });
	}
}

function askOrDefault(
	question: string,
	current: string | undefined,
	defaultValue: string,
	yes: boolean,
): Promise<string> {
	if (current !== undefined) return Promise.resolve(current);
	if (yes) return Promise.resolve(defaultValue);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return rl
		.question(`${question} [${defaultValue}]: `)
		.then((answer) => answer.trim() || defaultValue)
		.finally(() => rl.close());
}

async function collectAnswers(options: InitOptions): Promise<InitAnswers> {
	const name = await askOrDefault('Your name', options.name, 'Alex', Boolean(options.yes));
	const claudeApiKey = await askOrDefault(
		'Claude API key (optional)',
		options.claudeApiKey,
		'',
		Boolean(options.yes),
	);
	const telegramToken = await askOrDefault(
		'Telegram bot token (optional)',
		options.telegramToken,
		'',
		Boolean(options.yes),
	);

	return { name, claudeApiKey, telegramToken };
}

function renderConfig(template: string, answers: InitAnswers): string {
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
	const parsed = parseYaml(template) as Record<string, unknown>;
	const user = (parsed.user as Record<string, unknown> | undefined) ?? {};
	user.name = answers.name;
	user.timezone = timezone;
	user.locale = locale;
	parsed.user = user;

	const channels = (parsed.channels as Record<string, unknown> | undefined) ?? {};
	const telegram = (channels.telegram as Record<string, unknown> | undefined) ?? {};
	telegram.bot_token = answers.telegramToken || `\${MAMA_TELEGRAM_TOKEN}`;
	channels.telegram = telegram;
	parsed.channels = channels;

	const llm = (parsed.llm as Record<string, unknown> | undefined) ?? {};
	const providers = (llm.providers as Record<string, unknown> | undefined) ?? {};
	const claude = (providers.claude as Record<string, unknown> | undefined) ?? {};
	claude.api_key = answers.claudeApiKey;
	claude.default_model = claude.default_model ?? 'claude-sonnet-4-20250514';
	claude.max_monthly_budget_usd = claude.max_monthly_budget_usd ?? 50;
	providers.claude = claude;
	llm.providers = providers;
	parsed.llm = llm;

	return stringifyYaml(parsed);
}

function writeConfig(configPath: string, answers: InitAnswers, force = false): void {
	const template = readFileSync(resolveTemplatePath('config.default.yaml'), 'utf-8');
	const config = renderConfig(template, answers);

	if (existsSync(configPath) && !force) {
		throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
	}

	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, config, 'utf-8');
}

function copyTemplateIfMissing(srcName: string, destPath: string): void {
	if (existsSync(destPath)) return;
	copyFileSync(resolveTemplatePath(srcName), destPath);
}

export function registerInitCommand(program: Command): void {
	program
		.command('init')
		.description('Initialize Mama home directory and default configuration')
		.option('--name <name>', 'User name')
		.option('--claude-api-key <key>', 'Claude API key')
		.option('--telegram-token <token>', 'Telegram bot token')
		.option('-y, --yes', 'Use defaults and skip interactive prompts')
		.option('--force', 'Overwrite existing config')
		.action(async (options: InitOptions) => {
			try {
				const result = await runInit(options);
				process.stdout.write(`Initialized Mama at ${result.mamaHome}\n`);
				process.stdout.write(`Config: ${result.configPath}\n`);
				process.stdout.write(`Workspace: ${join(result.mamaHome, 'workspace')}\n`);
				process.stdout.write(`Next: run "mama chat"\n`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stderr.write(`Error: ${message}\n`);
				process.exitCode = 1;
			}
		});
}

export async function runInit(options: InitOptions): Promise<RunInitResult> {
	const mamaHome = getMamaHome();
	ensureMamaStructure(mamaHome);

	const answers = await collectAnswers(options);
	const configPath = getDefaultConfigPath();
	writeConfig(configPath, answers, options.force);

	copyTemplateIfMissing('SOUL.md', join(mamaHome, 'soul.md'));
	copyTemplateIfMissing('heartbeat.md', join(mamaHome, 'heartbeat.md'));

	return {
		mamaHome,
		configPath,
	};
}

export function defaultMamaHomePath(): string {
	return join(homedir(), '.mama');
}
