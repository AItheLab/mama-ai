import type { Command } from 'commander';
import type { CostTracker } from '../llm/cost-tracker.js';
import type { LLMUsageRecord } from '../llm/types.js';

type CostPeriod = 'today' | 'week' | 'month' | 'all';

interface RegisterCostCommandOptions {
	resolveTracker(configPath?: string): Promise<{
		tracker: CostTracker;
		close(): void;
	}>;
}

function formatUsd(value: number): string {
	return `$${value.toFixed(4)}`;
}

function formatInt(value: number): string {
	return value.toLocaleString('en-US');
}

function recordsForPeriod(tracker: CostTracker, period: CostPeriod): LLMUsageRecord[] {
	switch (period) {
		case 'today':
			return tracker.getUsageToday();
		case 'week':
			return tracker.getUsageThisWeek();
		case 'month':
			return tracker.getUsageThisMonth();
		default:
			return tracker.getRecords();
	}
}

async function withTracker<T>(
	options: RegisterCostCommandOptions,
	configPath: string | undefined,
	run: (tracker: CostTracker) => Promise<T>,
): Promise<T> {
	const services = await options.resolveTracker(configPath);
	try {
		return await run(services.tracker);
	} finally {
		services.close();
	}
}

export function registerCostCommand(program: Command, options: RegisterCostCommandOptions): void {
	program
		.command('cost')
		.option('-c, --config <path>', 'Path to config file')
		.option('--period <period>', 'today|week|month|all', 'today')
		.description('Show LLM usage and cost dashboard')
		.action(async (commandOptions: { config?: string; period: CostPeriod }) => {
			try {
				await withTracker(options, commandOptions.config, async (tracker) => {
					const period = (['today', 'week', 'month', 'all'] as CostPeriod[]).includes(
						commandOptions.period,
					)
						? commandOptions.period
						: 'today';
					const records = recordsForPeriod(tracker, period);
					const summary = tracker.summarize(records);
					process.stdout.write(`Cost dashboard (${period})\n`);
					process.stdout.write(
						`Records: ${records.length} | Input tokens: ${formatInt(summary.totalInputTokens)} | Output tokens: ${formatInt(summary.totalOutputTokens)}\n`,
					);
					process.stdout.write(
						`Total cost: ${formatUsd(summary.totalCostUsd)} | Avg/day: ${formatUsd(summary.averageCostPerDayUsd)}\n`,
					);
					process.stdout.write('\nBy model:\n');
					const modelEntries = Object.entries(summary.byModel).sort(
						(a, b) => b[1].costUsd - a[1].costUsd,
					);
					if (modelEntries.length === 0) {
						process.stdout.write('(no usage records)\n');
						return;
					}
					for (const [model, stats] of modelEntries) {
						process.stdout.write(
							`- ${model}: in=${formatInt(stats.inputTokens)} out=${formatInt(stats.outputTokens)} cost=${formatUsd(stats.costUsd)}\n`,
						);
					}
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stderr.write(`Error: ${message}\n`);
				process.exitCode = 1;
			}
		});
}

export type { CostPeriod, RegisterCostCommandOptions };
