import { beforeEach, describe, expect, it } from 'vitest';
import { createCostTracker } from '../cost-tracker.js';

describe('CostTracker', () => {
	let tracker: ReturnType<typeof createCostTracker>;

	beforeEach(() => {
		tracker = createCostTracker();
	});

	it('records usage and calculates cost for Claude models', () => {
		const record = tracker.record({
			provider: 'claude',
			model: 'claude-sonnet-4-20250514',
			usage: { inputTokens: 1000, outputTokens: 500 },
			taskType: 'general',
			latencyMs: 1200,
		});

		expect(record.costUsd).toBeGreaterThan(0);
		expect(record.inputTokens).toBe(1000);
		expect(record.outputTokens).toBe(500);
		expect(record.provider).toBe('claude');
	});

	it('records zero cost for Ollama (local) models', () => {
		const record = tracker.record({
			provider: 'ollama',
			model: 'llama3.2',
			usage: { inputTokens: 5000, outputTokens: 2000 },
			taskType: 'simple_tasks',
			latencyMs: 800,
		});

		expect(record.costUsd).toBe(0);
	});

	it('accumulates total cost across records', () => {
		tracker.record({
			provider: 'claude',
			model: 'claude-sonnet-4-20250514',
			usage: { inputTokens: 1000000, outputTokens: 0 },
			taskType: 'general',
			latencyMs: 100,
		});

		tracker.record({
			provider: 'claude',
			model: 'claude-sonnet-4-20250514',
			usage: { inputTokens: 0, outputTokens: 1000000 },
			taskType: 'general',
			latencyMs: 100,
		});

		// 1M input tokens at $3/M = $3, 1M output tokens at $15/M = $15
		expect(tracker.getTotalCost()).toBeCloseTo(18.0, 1);
	});

	it('returns usage records for today', () => {
		tracker.record({
			provider: 'claude',
			model: 'claude-sonnet-4-20250514',
			usage: { inputTokens: 100, outputTokens: 50 },
			taskType: 'general',
			latencyMs: 100,
		});

		expect(tracker.getUsageToday()).toHaveLength(1);
		expect(tracker.getCostToday()).toBeGreaterThan(0);
	});

	it('returns usage records for this month', () => {
		tracker.record({
			provider: 'ollama',
			model: 'llama3.2',
			usage: { inputTokens: 100, outputTokens: 50 },
			taskType: 'simple_tasks',
			latencyMs: 100,
		});

		expect(tracker.getUsageThisMonth()).toHaveLength(1);
	});

	it('clears all records', () => {
		tracker.record({
			provider: 'claude',
			model: 'claude-sonnet-4-20250514',
			usage: { inputTokens: 100, outputTokens: 50 },
			taskType: 'general',
			latencyMs: 100,
		});

		tracker.clear();
		expect(tracker.getRecords()).toHaveLength(0);
		expect(tracker.getTotalCost()).toBe(0);
	});
});
