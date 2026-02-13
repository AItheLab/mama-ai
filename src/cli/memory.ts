import type { Command } from 'commander';
import type {
	ConsolidatedMemory,
	ConsolidatedMemoryStore,
	MemoryCategory,
} from '../memory/consolidated.js';
import type { ConsolidationEngine } from '../memory/consolidation.js';
import type { Episode, EpisodicMemory } from '../memory/episodic.js';
import type { MemoryStore } from '../memory/store.js';

const CATEGORY_VALUES: [MemoryCategory, ...MemoryCategory[]] = [
	'fact',
	'preference',
	'pattern',
	'goal',
	'relationship',
	'skill',
	'routine',
	'emotional',
	'project',
];

interface MemoryStatsCountRow {
	count: number;
}

interface MemoryCategoryRow {
	category: string;
	count: number;
}

interface MemoryCliOutput {
	write(value: string): void;
	writeError(value: string): void;
}

interface CliColors {
	enabled: boolean;
}

export interface MemoryCliServices {
	store: MemoryStore;
	episodic: EpisodicMemory;
	consolidated: ConsolidatedMemoryStore;
	consolidation?: ConsolidationEngine;
	close(): void;
}

interface SearchOptions {
	limit?: number;
}

interface ListOptions {
	category?: MemoryCategory;
	minConfidence?: number;
}

export interface MemoryCliHandlers {
	search(query: string, options?: SearchOptions): Promise<string>;
	list(options?: ListOptions): Promise<string>;
	forget(id: string): Promise<string>;
	consolidate(): Promise<string>;
	stats(): Promise<string>;
}

interface RegisterMemoryCommandOptions {
	resolveServices(configPath?: string): Promise<MemoryCliServices>;
}

function withColor(text: string, code: string, colors: CliColors): string {
	if (!colors.enabled) return text;
	return `\x1b[${code}m${text}\x1b[0m`;
}

function title(text: string, colors: CliColors): string {
	return withColor(text, '1;36', colors);
}

function section(text: string, colors: CliColors): string {
	return withColor(text, '1;33', colors);
}

function ok(text: string, colors: CliColors): string {
	return withColor(text, '32', colors);
}

function dim(text: string, colors: CliColors): string {
	return withColor(text, '90', colors);
}

function danger(text: string, colors: CliColors): string {
	return withColor(text, '31', colors);
}

function clampLimit(value: number | undefined, fallback: number): number {
	if (!value || Number.isNaN(value)) return fallback;
	return Math.max(1, Math.min(100, Math.floor(value)));
}

function summarizeContent(content: string, max = 140): string {
	if (content.length <= max) return content;
	return `${content.slice(0, max - 3)}...`;
}

function formatDate(value: Date): string {
	return value.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function formatConsolidatedMemoryLine(
	index: number,
	memory: ConsolidatedMemory,
	colors: CliColors,
): string {
	const meta = dim(
		`${memory.id} | ${memory.category} | confidence=${memory.confidence.toFixed(2)} | active=${memory.active ? 'yes' : 'no'} | reinforced=${memory.reinforcementCount}`,
		colors,
	);
	const content = summarizeContent(memory.content, 220);
	return `${index}. ${content}\n   ${meta}`;
}

function formatEpisodeLine(index: number, episode: Episode, colors: CliColors): string {
	const meta = dim(
		`${episode.id} | ${episode.role} | ${episode.channel} | ${formatDate(episode.timestamp)}`,
		colors,
	);
	const content = summarizeContent(episode.content, 200);
	return `${index}. ${content}\n   ${meta}`;
}

function readCount(store: MemoryStore, sql: string): number {
	const row = store.get<MemoryStatsCountRow>(sql);
	return row?.count ?? 0;
}

function readCategoryDistribution(store: MemoryStore): MemoryCategoryRow[] {
	return store.all<MemoryCategoryRow>(
		`SELECT category, COUNT(*) AS count
		 FROM memories
		 GROUP BY category
		 ORDER BY count DESC, category ASC`,
	);
}

function createMemoryCliOutput(): MemoryCliOutput {
	return {
		write(value: string) {
			process.stdout.write(value);
		},
		writeError(value: string) {
			process.stderr.write(value);
		},
	};
}

function getColors(): CliColors {
	return {
		enabled: process.env.NO_COLOR !== '1',
	};
}

function categoryOptionValue(value: string): MemoryCategory {
	if (CATEGORY_VALUES.includes(value as MemoryCategory)) {
		return value as MemoryCategory;
	}
	throw new Error(`Invalid category "${value}". Expected one of: ${CATEGORY_VALUES.join(', ')}`);
}

function renderConsolidatedSearchSection(
	memories: ConsolidatedMemory[],
	colors: CliColors,
): string[] {
	const lines = [section('Consolidated Memories', colors)];
	if (memories.length === 0) {
		lines.push(dim('No consolidated memory matches.', colors));
		return lines;
	}

	for (let i = 0; i < memories.length; i++) {
		const memory = memories[i];
		if (memory) {
			lines.push(formatConsolidatedMemoryLine(i + 1, memory, colors));
		}
	}

	return lines;
}

function renderEpisodicSearchSection(episodes: Episode[], colors: CliColors): string[] {
	const lines = [section('Episodic Memories', colors)];
	if (episodes.length === 0) {
		lines.push(dim('No episodic memory matches.', colors));
		return lines;
	}

	for (let i = 0; i < episodes.length; i++) {
		const episode = episodes[i];
		if (episode) {
			lines.push(formatEpisodeLine(i + 1, episode, colors));
		}
	}

	return lines;
}

export function createMemoryCliHandlers(
	services: MemoryCliServices,
	colors: CliColors = getColors(),
): MemoryCliHandlers {
	async function search(query: string, options: SearchOptions = {}): Promise<string> {
		const limit = clampLimit(options.limit, 10);
		const [memories, episodes] = await Promise.all([
			services.consolidated.search(query, { topK: limit, includeInactive: true, minConfidence: 0 }),
			services.episodic.searchSemantic(query, { topK: limit }),
		]);

		const lines: string[] = [];
		lines.push(`${title('Memory Search', colors)}  ${dim(`query="${query}"`, colors)}`);
		lines.push(`${dim(`Top ${limit} per source`, colors)}\n`);
		lines.push(...renderConsolidatedSearchSection(memories, colors));
		lines.push('');
		lines.push(...renderEpisodicSearchSection(episodes, colors));

		return `${lines.join('\n')}\n`;
	}

	async function list(options: ListOptions = {}): Promise<string> {
		const minConfidence = options.minConfidence ?? 0;
		const memories = options.category
			? (await services.consolidated.getByCategory(options.category)).filter(
					(memory) => memory.confidence >= minConfidence,
				)
			: await services.consolidated.getActive(minConfidence);

		const lines: string[] = [];
		lines.push(title('Consolidated Memories', colors));
		lines.push(
			dim(
				`count=${memories.length} | minConfidence=${minConfidence.toFixed(2)}${
					options.category ? ` | category=${options.category}` : ''
				}`,
				colors,
			),
		);
		lines.push('');

		if (memories.length === 0) {
			lines.push(dim('No memories found for the selected filters.', colors));
			return `${lines.join('\n')}\n`;
		}

		for (let i = 0; i < memories.length; i++) {
			const memory = memories[i];
			if (memory) {
				lines.push(formatConsolidatedMemoryLine(i + 1, memory, colors));
			}
		}

		return `${lines.join('\n')}\n`;
	}

	async function forget(id: string): Promise<string> {
		await services.consolidated.deactivate(id);
		return `${ok('Memory deactivated.', colors)} ${dim(id, colors)}\n`;
	}

	async function consolidate(): Promise<string> {
		if (!services.consolidation) {
			throw new Error('Consolidation engine is not available.');
		}
		const report = await services.consolidation.runConsolidation({ force: true });

		const lines: string[] = [];
		lines.push(title('Consolidation Report', colors));
		lines.push(dim(`${report.startedAt} -> ${report.finishedAt}`, colors));
		lines.push('');
		if (report.skipped) {
			lines.push(`${section('Status', colors)} ${dim('skipped', colors)}`);
			lines.push(dim(report.skipReason ?? 'No reason provided', colors));
			return `${lines.join('\n')}\n`;
		}

		lines.push(`${section('Processed episodes', colors)} ${report.processedEpisodes}`);
		lines.push(`${section('Created', colors)} ${report.created}`);
		lines.push(`${section('Reinforced', colors)} ${report.reinforced}`);
		lines.push(`${section('Updated', colors)} ${report.updated}`);
		lines.push(`${section('Contradicted', colors)} ${report.contradicted}`);
		lines.push(`${section('Decayed', colors)} ${report.decayed}`);
		lines.push(`${section('Deactivated', colors)} ${report.deactivated}`);
		lines.push(`${section('Connected', colors)} ${report.connected}`);
		if (report.errors.length > 0) {
			lines.push('');
			lines.push(section('Errors', colors));
			for (const error of report.errors) {
				lines.push(`${danger('-', colors)} ${error}`);
			}
		}

		return `${lines.join('\n')}\n`;
	}

	async function stats(): Promise<string> {
		const totalEpisodes = readCount(services.store, 'SELECT COUNT(*) AS count FROM episodes');
		const unconsolidatedEpisodes = readCount(
			services.store,
			'SELECT COUNT(*) AS count FROM episodes WHERE consolidated = 0',
		);
		const totalMemories = readCount(services.store, 'SELECT COUNT(*) AS count FROM memories');
		const activeMemories = readCount(
			services.store,
			'SELECT COUNT(*) AS count FROM memories WHERE active = 1',
		);
		const inactiveMemories = readCount(
			services.store,
			'SELECT COUNT(*) AS count FROM memories WHERE active = 0',
		);
		const enabledJobs = readCount(
			services.store,
			'SELECT COUNT(*) AS count FROM jobs WHERE enabled = 1',
		);
		const categoryRows = readCategoryDistribution(services.store);

		const lines: string[] = [];
		lines.push(title('Memory Stats', colors));
		lines.push('');
		lines.push(section('Episodes', colors));
		lines.push(`- total: ${totalEpisodes}`);
		lines.push(`- unconsolidated: ${unconsolidatedEpisodes}`);
		lines.push('');
		lines.push(section('Consolidated Memories', colors));
		lines.push(`- total: ${totalMemories}`);
		lines.push(`- active: ${activeMemories}`);
		lines.push(`- inactive: ${inactiveMemories}`);
		lines.push('');
		lines.push(section('Scheduler', colors));
		lines.push(`- enabled jobs: ${enabledJobs}`);
		lines.push('');
		lines.push(section('By Category', colors));
		if (categoryRows.length === 0) {
			lines.push(dim('(No consolidated memories yet)', colors));
		} else {
			for (const row of categoryRows) {
				lines.push(`- ${row.category}: ${row.count}`);
			}
		}

		return `${lines.join('\n')}\n`;
	}

	return {
		search,
		list,
		forget,
		consolidate,
		stats,
	};
}

async function withServices<T>(
	resolveServices: RegisterMemoryCommandOptions['resolveServices'],
	configPath: string | undefined,
	run: (handlers: MemoryCliHandlers) => Promise<T>,
): Promise<T> {
	const services = await resolveServices(configPath);
	try {
		const handlers = createMemoryCliHandlers(services);
		return await run(handlers);
	} finally {
		services.close();
	}
}

function writeOutput(output: MemoryCliOutput, text: string): void {
	output.write(text);
}

function writeFailure(output: MemoryCliOutput, error: unknown): void {
	const colors = getColors();
	const message = error instanceof Error ? error.message : String(error);
	output.writeError(`${danger('Error:', colors)} ${message}\n`);
}

export function registerMemoryCommands(
	program: Command,
	options: RegisterMemoryCommandOptions,
): void {
	const output = createMemoryCliOutput();
	const memory = program.command('memory').description('Memory operations');

	memory
		.command('search')
		.argument('<query>', 'Search query')
		.option('-c, --config <path>', 'Path to config file')
		.option('-l, --limit <n>', 'Top results per source', (value: string) =>
			Number.parseInt(value, 10),
		)
		.description('Semantic search across consolidated and episodic memories')
		.action(async (query: string, commandOptions: { config?: string; limit?: number }) => {
			try {
				const rendered = await withServices(
					options.resolveServices,
					commandOptions.config,
					(handlers) => handlers.search(query, { limit: commandOptions.limit }),
				);
				writeOutput(output, rendered);
			} catch (error) {
				writeFailure(output, error);
				process.exitCode = 1;
			}
		});

	memory
		.command('list')
		.option('-c, --config <path>', 'Path to config file')
		.option('--category <category>', 'Filter by category', categoryOptionValue)
		.option('--min-confidence <value>', 'Minimum confidence (0-1)', (value: string) =>
			Number.parseFloat(value),
		)
		.description('List consolidated memories')
		.action(
			async (commandOptions: {
				config?: string;
				category?: MemoryCategory;
				minConfidence?: number;
			}) => {
				try {
					const rendered = await withServices(
						options.resolveServices,
						commandOptions.config,
						(handlers) =>
							handlers.list({
								category: commandOptions.category,
								minConfidence: commandOptions.minConfidence,
							}),
					);
					writeOutput(output, rendered);
				} catch (error) {
					writeFailure(output, error);
					process.exitCode = 1;
				}
			},
		);

	memory
		.command('forget')
		.argument('<id>', 'Memory ID')
		.option('-c, --config <path>', 'Path to config file')
		.description('Deactivate a specific consolidated memory')
		.action(async (id: string, commandOptions: { config?: string }) => {
			try {
				const rendered = await withServices(
					options.resolveServices,
					commandOptions.config,
					(handlers) => handlers.forget(id),
				);
				writeOutput(output, rendered);
			} catch (error) {
				writeFailure(output, error);
				process.exitCode = 1;
			}
		});

	memory
		.command('consolidate')
		.option('-c, --config <path>', 'Path to config file')
		.description('Manually run memory consolidation now')
		.action(async (commandOptions: { config?: string }) => {
			try {
				const rendered = await withServices(
					options.resolveServices,
					commandOptions.config,
					(handlers) => handlers.consolidate(),
				);
				writeOutput(output, rendered);
			} catch (error) {
				writeFailure(output, error);
				process.exitCode = 1;
			}
		});

	memory
		.command('stats')
		.option('-c, --config <path>', 'Path to config file')
		.description('Show memory statistics')
		.action(async (commandOptions: { config?: string }) => {
			try {
				const rendered = await withServices(
					options.resolveServices,
					commandOptions.config,
					(handlers) => handlers.stats(),
				);
				writeOutput(output, rendered);
			} catch (error) {
				writeFailure(output, error);
				process.exitCode = 1;
			}
		});
}
