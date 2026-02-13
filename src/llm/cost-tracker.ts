import { createLogger } from '../utils/logger.js';
import type { LLMProvider, LLMUsageRecord, TaskType, TokenUsage } from './types.js';

const logger = createLogger('llm:cost-tracker');

/** Cost per 1M tokens (input/output) by model */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
	'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
	'claude-haiku-4-20250514': { input: 0.8, output: 4.0 },
	'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
	// Ollama models are free (local)
	default: { input: 0, output: 0 },
};

function getCostForModel(model: string, usage: TokenUsage): number {
	const defaultPricing = { input: 0, output: 0 };
	const pricing = MODEL_PRICING[model] ?? defaultPricing;
	const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
	const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
	return inputCost + outputCost;
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
	getUsageThisMonth(): LLMUsageRecord[];
	getTotalCost(): number;
	getCostToday(): number;
	getCostThisMonth(): number;
	getRecords(): LLMUsageRecord[];
	clear(): void;
}

/**
 * Creates an in-memory cost tracker for LLM usage.
 * Phase 3 will persist this to SQLite.
 */
export function createCostTracker(): CostTracker {
	const records: LLMUsageRecord[] = [];
	let idCounter = 0;

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
			timestamp: new Date(),
			provider: params.provider,
			model: params.model,
			inputTokens: params.usage.inputTokens,
			outputTokens: params.usage.outputTokens,
			costUsd,
			taskType: params.taskType,
			latencyMs: params.latencyMs,
		};

		records.push(entry);

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
		return records.filter((r) => r.timestamp >= start);
	}

	function getUsageToday(): LLMUsageRecord[] {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return filterByDate(today);
	}

	function getUsageThisMonth(): LLMUsageRecord[] {
		const monthStart = new Date();
		monthStart.setDate(1);
		monthStart.setHours(0, 0, 0, 0);
		return filterByDate(monthStart);
	}

	function sumCost(entries: LLMUsageRecord[]): number {
		return entries.reduce((sum, r) => sum + r.costUsd, 0);
	}

	return {
		record,
		getUsageToday,
		getUsageThisMonth,
		getTotalCost: () => sumCost(records),
		getCostToday: () => sumCost(getUsageToday()),
		getCostThisMonth: () => sumCost(getUsageThisMonth()),
		getRecords: () => [...records],
		clear: () => {
			records.length = 0;
			idCounter = 0;
		},
	};
}
