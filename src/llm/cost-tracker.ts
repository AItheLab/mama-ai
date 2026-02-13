import type { MemoryStore } from '../memory/store.js';
import { createLogger } from '../utils/logger.js';
import type { LLMProvider, LLMUsageRecord, TaskType, TokenUsage } from './types.js';

const logger = createLogger('llm:cost-tracker');

/** Cost per 1M tokens (input/output) by model */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
	'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
	'claude-haiku-4-20250514': { input: 0.8, output: 4.0 },
	'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
	// Ollama models are free by default.
	default: { input: 0, output: 0 },
};

interface CostTrackerOptions {
	store?: MemoryStore;
	clock?: () => Date;
}

interface UsageSummary {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCostUsd: number;
	averageCostPerDayUsd: number;
	byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

interface CostTracker {
	record(params: {
		provider: LLMProvider;
		model: string;
		usage: TokenUsage;
		taskType: TaskType;
		latencyMs: number;
	}): LLMUsageRecord;
	getUsageToday(): LLMUsageRecord[];
	getUsageThisWeek(): LLMUsageRecord[];
	getUsageThisMonth(): LLMUsageRecord[];
	getTotalCost(): number;
	getCostToday(): number;
	getCostThisMonth(): number;
	getRecords(): LLMUsageRecord[];
	summarize(records?: LLMUsageRecord[]): UsageSummary;
	clear(): void;
}

interface UsageRow {
	id: string;
	timestamp: string;
	provider: LLMProvider;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	task_type: TaskType;
	latency_ms: number;
}

function getCostForModel(model: string, usage: TokenUsage): number {
	const fallbackPricing = MODEL_PRICING.default ?? { input: 0, output: 0 };
	const pricing = MODEL_PRICING[model] ?? fallbackPricing;
	const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
	const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
	return inputCost + outputCost;
}

function parseUsageRow(row: UsageRow): LLMUsageRecord {
	return {
		id: row.id,
		timestamp: new Date(row.timestamp),
		provider: row.provider,
		model: row.model,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		costUsd: row.cost_usd,
		taskType: row.task_type,
		latencyMs: row.latency_ms,
	};
}

function startOfDay(date: Date): Date {
	const copy = new Date(date);
	copy.setHours(0, 0, 0, 0);
	return copy;
}

function startOfWeek(date: Date): Date {
	const day = date.getDay(); // Sunday=0
	const copy = startOfDay(date);
	copy.setDate(copy.getDate() - day);
	return copy;
}

function startOfMonth(date: Date): Date {
	const copy = startOfDay(date);
	copy.setDate(1);
	return copy;
}

function sumCost(entries: LLMUsageRecord[]): number {
	return entries.reduce((sum, record) => sum + record.costUsd, 0);
}

function sumTokens(entries: LLMUsageRecord[]): { input: number; output: number } {
	return entries.reduce(
		(acc, record) => ({
			input: acc.input + record.inputTokens,
			output: acc.output + record.outputTokens,
		}),
		{ input: 0, output: 0 },
	);
}

function estimateAverageCostPerDay(entries: LLMUsageRecord[]): number {
	if (entries.length === 0) return 0;
	const timestamps = entries.map((entry) => entry.timestamp.getTime());
	const min = Math.min(...timestamps);
	const max = Math.max(...timestamps);
	const days = Math.max(1, Math.ceil((max - min) / 86_400_000) + 1);
	return sumCost(entries) / days;
}

/**
 * Creates a cost tracker and optionally persists usage in SQLite.
 */
export function createCostTracker(options: CostTrackerOptions = {}): CostTracker {
	const records: LLMUsageRecord[] = [];
	const clock = options.clock ?? (() => new Date());
	let idCounter = 0;

	if (options.store) {
		const rows = options.store.all<UsageRow>(
			`SELECT id, timestamp, provider, model, input_tokens, output_tokens, cost_usd, task_type, latency_ms
			 FROM llm_usage
			 ORDER BY timestamp ASC`,
		);
		for (const row of rows) {
			records.push(parseUsageRow(row));
		}
		idCounter = rows.length;
	}

	function persist(entry: LLMUsageRecord): void {
		if (!options.store) return;
		options.store.run(
			`INSERT INTO llm_usage (id, timestamp, provider, model, input_tokens, output_tokens, cost_usd, task_type, latency_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				entry.id,
				entry.timestamp.toISOString(),
				entry.provider,
				entry.model,
				entry.inputTokens,
				entry.outputTokens,
				entry.costUsd,
				entry.taskType,
				entry.latencyMs,
			],
		);
	}

	function record(params: {
		provider: LLMProvider;
		model: string;
		usage: TokenUsage;
		taskType: TaskType;
		latencyMs: number;
	}): LLMUsageRecord {
		const costUsd = getCostForModel(params.model, params.usage);
		idCounter++;

		const entry: LLMUsageRecord = {
			id: `usage-${idCounter}`,
			timestamp: clock(),
			provider: params.provider,
			model: params.model,
			inputTokens: params.usage.inputTokens,
			outputTokens: params.usage.outputTokens,
			costUsd,
			taskType: params.taskType,
			latencyMs: params.latencyMs,
		};

		records.push(entry);
		persist(entry);

		logger.debug('LLM usage recorded', {
			model: params.model,
			inputTokens: params.usage.inputTokens,
			outputTokens: params.usage.outputTokens,
			costUsd: costUsd.toFixed(6),
			latencyMs: params.latencyMs,
		});

		return entry;
	}

	function filterByDate(start: Date): LLMUsageRecord[] {
		return records.filter((record) => record.timestamp >= start);
	}

	function getUsageToday(): LLMUsageRecord[] {
		return filterByDate(startOfDay(clock()));
	}

	function getUsageThisWeek(): LLMUsageRecord[] {
		return filterByDate(startOfWeek(clock()));
	}

	function getUsageThisMonth(): LLMUsageRecord[] {
		return filterByDate(startOfMonth(clock()));
	}

	function summarize(entries: LLMUsageRecord[] = records): UsageSummary {
		const byModel: UsageSummary['byModel'] = {};
		for (const record of entries) {
			const current = byModel[record.model] ?? {
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
			};
			current.inputTokens += record.inputTokens;
			current.outputTokens += record.outputTokens;
			current.costUsd += record.costUsd;
			byModel[record.model] = current;
		}

		const totals = sumTokens(entries);
		return {
			totalInputTokens: totals.input,
			totalOutputTokens: totals.output,
			totalCostUsd: sumCost(entries),
			averageCostPerDayUsd: estimateAverageCostPerDay(entries),
			byModel,
		};
	}

	function clear(): void {
		records.length = 0;
		idCounter = 0;
		if (options.store) {
			options.store.run('DELETE FROM llm_usage');
		}
	}

	return {
		record,
		getUsageToday,
		getUsageThisWeek,
		getUsageThisMonth,
		getTotalCost: () => sumCost(records),
		getCostToday: () => sumCost(getUsageToday()),
		getCostThisMonth: () => sumCost(getUsageThisMonth()),
		getRecords: () => [...records],
		summarize,
		clear,
	};
}

export type { CostTracker, CostTrackerOptions, UsageSummary };
