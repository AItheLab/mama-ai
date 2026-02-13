import type { ExecutionPlan, ExecutionPlanStep } from './planner.js';
import { executeTool } from './tools/index.js';
import type { ToolContext, ToolResult } from './tools/types.js';

export type PlanStepStatus =
	| 'success'
	| 'failed-acceptable'
	| 'failed-critical'
	| 'fallback'
	| 'skipped';

export interface PlanStepExecutionResult {
	stepId: number;
	tool: string;
	description: string;
	status: PlanStepStatus;
	attempts: number;
	output?: unknown;
	error?: string;
}

export interface PlanExecutionResult {
	aborted: boolean;
	completedSteps: number;
	totalSteps: number;
	results: PlanStepExecutionResult[];
}

export type ExecutorEvent =
	| {
			type: 'plan_step_started';
			stepId: number;
			description: string;
			tool: string;
	  }
	| {
			type: 'plan_step_finished';
			stepId: number;
			description: string;
			tool: string;
			status: PlanStepStatus;
			error?: string;
			attempts: number;
			percentComplete: number;
	  };

interface ExecutorContext extends ToolContext {
	onEvent?: (event: ExecutorEvent) => void;
}

interface ExecutorDeps {
	maxRetries?: number;
	executeToolFn?: typeof executeTool;
}

interface PlanExecutor {
	executePlan(plan: ExecutionPlan, context: ExecutorContext): Promise<PlanExecutionResult>;
}

const DEFAULT_MAX_RETRIES = 1;

function parseFallbackInstruction(
	value: string | undefined,
): { toolName: string; params: Record<string, unknown> } | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s*(\{[\s\S]*\})?$/i);
	if (!match?.[1]) return null;

	const toolName = match[1];
	const rawParams = match[2];
	if (!toolName) return null;

	if (!rawParams) {
		return { toolName, params: {} };
	}

	try {
		const parsed = JSON.parse(rawParams) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { toolName, params: parsed as Record<string, unknown> };
		}
		return { toolName, params: {} };
	} catch {
		return null;
	}
}

export function createExecutor(deps: ExecutorDeps = {}): PlanExecutor {
	const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
	const toolExecutor = deps.executeToolFn ?? executeTool;

	async function runStep(
		step: ExecutionPlanStep,
		context: ExecutorContext,
		retries: number,
	): Promise<PlanStepExecutionResult & { rawResult: ToolResult }> {
		let attempts = 0;
		let lastResult: ToolResult = {
			success: false,
			output: null,
			error: 'Tool did not execute',
		};

		for (let i = 0; i <= retries; i++) {
			attempts++;
			lastResult = await toolExecutor(step.tool, step.params, context);
			if (lastResult.success) {
				return {
					stepId: step.id,
					tool: step.tool,
					description: step.description,
					status: 'success',
					attempts,
					output: lastResult.output,
					rawResult: lastResult,
				};
			}
		}

		return {
			stepId: step.id,
			tool: step.tool,
			description: step.description,
			status: step.canFail ? 'failed-acceptable' : 'failed-critical',
			attempts,
			error: lastResult.error ?? 'Step failed',
			output: lastResult.output,
			rawResult: lastResult,
		};
	}

	async function executePlan(
		plan: ExecutionPlan,
		context: ExecutorContext,
	): Promise<PlanExecutionResult> {
		const completed = new Set<number>();
		const results: PlanStepExecutionResult[] = [];
		let aborted = false;

		for (const [index, step] of plan.steps.entries()) {
			const dependenciesReady = step.dependsOn.every((id) => completed.has(id));
			if (!dependenciesReady) {
				const skipped: PlanStepExecutionResult = {
					stepId: step.id,
					tool: step.tool,
					description: step.description,
					status: 'skipped',
					attempts: 0,
					error: 'Dependencies not met',
				};
				results.push(skipped);
				continue;
			}

			context.onEvent?.({
				type: 'plan_step_started',
				stepId: step.id,
				description: step.description,
				tool: step.tool,
			});

			const stepResult = await runStep(step, context, maxRetries);
			let finalResult: PlanStepExecutionResult = { ...stepResult };

			if (!stepResult.rawResult.success) {
				const fallback = parseFallbackInstruction(step.fallback);
				if (fallback) {
					const fallbackRun = await toolExecutor(fallback.toolName, fallback.params, context);
					if (fallbackRun.success) {
						finalResult = {
							stepId: step.id,
							tool: fallback.toolName,
							description: step.description,
							status: 'fallback',
							attempts: stepResult.attempts + 1,
							output: fallbackRun.output,
						};
					} else {
						finalResult = {
							...finalResult,
							attempts: stepResult.attempts + 1,
							error: fallbackRun.error ?? finalResult.error,
						};
					}
				}
			}

			results.push(finalResult);
			if (finalResult.status === 'success' || finalResult.status === 'fallback') {
				completed.add(step.id);
			}
			if (finalResult.status === 'failed-acceptable') {
				completed.add(step.id);
			}

			const percentComplete = Math.round(((index + 1) / plan.steps.length) * 100);
			context.onEvent?.({
				type: 'plan_step_finished',
				stepId: step.id,
				description: step.description,
				tool: finalResult.tool,
				status: finalResult.status,
				error: finalResult.error,
				attempts: finalResult.attempts,
				percentComplete,
			});

			if (finalResult.status === 'failed-critical') {
				aborted = true;
				break;
			}
		}

		return {
			aborted,
			completedSteps: completed.size,
			totalSteps: plan.steps.length,
			results,
		};
	}

	return { executePlan };
}
