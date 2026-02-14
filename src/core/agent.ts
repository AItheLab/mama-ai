import type { createLLMRouter } from '../llm/router.js';
import type { LLMRequest, Message } from '../llm/types.js';
import type { EpisodicMemory } from '../memory/episodic.js';
import type { MemoryRetrievalPipeline } from '../memory/retrieval.js';
import type { createSoul } from '../memory/soul.js';
import type { createWorkingMemory } from '../memory/working.js';
import { createLogger } from '../utils/logger.js';
import { buildSystemPrompt } from './context.js';
import { createExecutor } from './executor.js';
import { createPlanner, type ExecutionPlan } from './planner.js';
import { executeTool, getToolDefinitions } from './tools/index.js';
import type { SandboxExecutor } from './tools/types.js';
import type { AgentEvent, AgentResponse, AgentRunOptions, ChannelName } from './types.js';

const logger = createLogger('core:agent');

interface AgentDeps {
	router: ReturnType<typeof createLLMRouter>;
	workingMemory: ReturnType<typeof createWorkingMemory>;
	soul: ReturnType<typeof createSoul>;
	sandbox?: SandboxExecutor;
	episodicMemory?: EpisodicMemory;
	retrieval?: MemoryRetrievalPipeline;
	retrievalTokenBudget?: number;
	maxIterations?: number;
}

interface Agent {
	processMessage(
		input: string,
		channel: ChannelName,
		options?: AgentRunOptions,
	): Promise<AgentResponse>;
	getConversationHistory(): Message[];
	clearHistory(): void;
}

/**
 * Creates the main Mama agent.
 * Processes user messages through the LLM router with context management.
 */
export function createAgent(deps: AgentDeps): Agent {
	const { router, workingMemory, soul, sandbox, episodicMemory, retrieval } = deps;
	const planner = createPlanner({ router });
	const executor = createExecutor();
	const maxIterations = deps.maxIterations ?? 10;
	const retrievalTokenBudget = deps.retrievalTokenBudget ?? 1200;

	function emit(options: AgentRunOptions | undefined, event: AgentEvent): void {
		options?.onEvent?.(event);
	}

	function buildRequest(toolsEnabled: boolean, channel?: string): LLMRequest {
		return {
			messages: workingMemory.getMessages(),
			systemPrompt: buildSystemPrompt(
				soul.getSoulPrompt(),
				workingMemory.getSystemInjection(),
				channel,
			),
			taskType: 'general',
			maxTokens: 4096,
			tools: toolsEnabled ? getToolDefinitions() : undefined,
		};
	}

	function stringifyToolResult(result: {
		success: boolean;
		output: unknown;
		error?: string;
	}): string {
		return JSON.stringify({
			success: result.success,
			output: result.output,
			error: result.error,
		});
	}

	function formatPlanSummary(plan: ExecutionPlan): string {
		const stepLines = plan.steps.map((step) => `${step.id}. ${step.description} [${step.tool}]`);
		const riskLine = plan.risks.length > 0 ? `\nRisks: ${plan.risks.join('; ')}` : '';
		return [`Plan: ${plan.goal}`, ...stepLines, riskLine].filter(Boolean).join('\n');
	}

	function formatExecutionSummary(
		plan: ExecutionPlan,
		result: AgentResponse['planExecution'],
	): string {
		if (!result) {
			return `Plan created for "${plan.goal}", but no execution results are available.`;
		}

		const lines = [`Plan executed: ${plan.goal}`];
		for (const step of result.results) {
			const detail = step.error ? ` — ${step.error}` : '';
			lines.push(`${step.stepId}. ${step.description}: ${step.status}${detail}`);
		}
		if (result.aborted) {
			lines.push('Execution aborted due to a critical step failure.');
		}
		return lines.join('\n');
	}

	async function recordEpisode(
		channel: ChannelName,
		role: 'system' | 'user' | 'assistant' | 'tool',
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		if (!episodicMemory) return;

		try {
			await episodicMemory.storeEpisode({
				channel,
				role,
				content,
				metadata,
			});
		} catch (error) {
			logger.warn('Failed to record episodic memory', {
				channel,
				role,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function refreshRetrievedContext(input: string): Promise<void> {
		if (!retrieval) return;

		try {
			const context = await retrieval.retrieveContext(input, retrievalTokenBudget);
			workingMemory.setSystemInjection(context.entries);
		} catch (error) {
			workingMemory.setSystemInjection([]);
			logger.warn('Failed to retrieve memory context', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function processMessage(
		input: string,
		channel: ChannelName,
		options?: AgentRunOptions,
	): Promise<AgentResponse> {
		logger.info('Processing message', { channel, inputLength: input.length });

		// Add user message to working memory
		const userMessage: Message = { role: 'user', content: input };
		workingMemory.addMessage(userMessage);
		await recordEpisode(channel, 'user', input, { event: 'user_message' });
		await refreshRetrievedContext(input);

		// Multi-step planning path
		if (sandbox && planner.shouldPlan(input)) {
			const plan = await planner.createPlan(input, workingMemory.getMessages());
			if (plan) {
				emit(options, { type: 'plan_created', plan });
				await recordEpisode(channel, 'system', formatPlanSummary(plan), {
					event: 'plan_created',
					stepCount: plan.steps.length,
					hasSideEffects: plan.hasSideEffects,
				});

				if (plan.hasSideEffects) {
					emit(options, { type: 'plan_approval_requested', plan });
					const approved = options?.onPlanApproval ? await options.onPlanApproval(plan) : false;
					if (!approved) {
						const cancelled = `Plan cancelled by user.\n${formatPlanSummary(plan)}`;
						workingMemory.addMessage({ role: 'assistant', content: cancelled });
						await recordEpisode(channel, 'assistant', cancelled, { event: 'plan_cancelled' });
						return {
							content: cancelled,
							model: 'planner-executor',
							provider: 'internal',
							tokenUsage: { input: 0, output: 0 },
							iterations: 0,
							toolCallsExecuted: 0,
						};
					}
				}

				const execution = await executor.executePlan(plan, {
					sandbox,
					requestedBy: channel,
					onEvent: (event) => emit(options, event),
				});

				const summary = formatExecutionSummary(plan, execution);
				workingMemory.addMessage({ role: 'assistant', content: summary });
				await recordEpisode(channel, 'assistant', summary, {
					event: 'plan_executed',
					aborted: execution.aborted,
					stepCount: execution.results.length,
				});
				return {
					content: summary,
					model: 'planner-executor',
					provider: 'internal',
					tokenUsage: { input: 0, output: 0 },
					iterations: 0,
					toolCallsExecuted: execution.results.length,
					planExecution: execution,
				};
			}
		}

		// Standard ReAct loop with tool use
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let toolCallsExecuted = 0;

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const response = await router.complete(buildRequest(Boolean(sandbox), channel));
			totalInputTokens += response.usage.inputTokens;
			totalOutputTokens += response.usage.outputTokens;

			if (response.toolCalls.length === 0) {
				workingMemory.addMessage({
					role: 'assistant',
					content: response.content,
				});
				await recordEpisode(channel, 'assistant', response.content, {
					event: 'assistant_response',
					model: response.model,
					provider: response.provider,
					iterations: iteration + 1,
				});

				logger.info('Message processed', {
					channel,
					model: response.model,
					provider: response.provider,
					inputTokens: totalInputTokens,
					outputTokens: totalOutputTokens,
					iterations: iteration + 1,
					toolCallsExecuted,
				});

				return {
					content: response.content,
					model: response.model,
					provider: response.provider,
					tokenUsage: {
						input: totalInputTokens,
						output: totalOutputTokens,
					},
					iterations: iteration + 1,
					toolCallsExecuted,
				};
			}

			if (!sandbox) {
				const noSandboxMessage = 'Tool call requested but sandbox is not configured.';
				workingMemory.addMessage({ role: 'assistant', content: noSandboxMessage });
				await recordEpisode(channel, 'assistant', noSandboxMessage, {
					event: 'tool_unavailable',
				});
				return {
					content: noSandboxMessage,
					model: response.model,
					provider: response.provider,
					tokenUsage: {
						input: totalInputTokens,
						output: totalOutputTokens,
					},
					iterations: iteration + 1,
					toolCallsExecuted,
				};
			}

			workingMemory.addMessage({
				role: 'assistant',
				content: response.content,
				toolCalls: response.toolCalls,
			});
			if (response.content.trim().length > 0) {
				await recordEpisode(channel, 'assistant', response.content, {
					event: 'assistant_tool_request',
					toolCount: response.toolCalls.length,
				});
			}

			for (const toolCall of response.toolCalls) {
				emit(options, {
					type: 'tool_call_started',
					callId: toolCall.id,
					toolName: toolCall.name,
				});
				const result = await executeTool(toolCall.name, toolCall.arguments, {
					sandbox,
					requestedBy: channel,
				});
				toolCallsExecuted++;
				emit(options, {
					type: 'tool_call_finished',
					callId: toolCall.id,
					toolName: toolCall.name,
					success: result.success,
					error: result.error,
				});
				const toolResultContent = stringifyToolResult(result);

				workingMemory.addMessage({
					role: 'tool',
					content: toolResultContent,
					toolResultId: toolCall.id,
				});
				await recordEpisode(channel, 'tool', toolResultContent, {
					event: 'tool_result',
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					success: result.success,
				});
			}
		}

		const limitMessage = `Maximum tool iterations (${maxIterations}) reached. Please refine the request.`;
		workingMemory.addMessage({ role: 'assistant', content: limitMessage });
		await recordEpisode(channel, 'assistant', limitMessage, {
			event: 'tool_iteration_limit',
			maxIterations,
		});

		logger.warn('Tool iteration limit reached', {
			channel,
			maxIterations,
			toolCallsExecuted,
		});

		return {
			content: limitMessage,
			model: 'tool-loop',
			provider: 'internal',
			tokenUsage: {
				input: totalInputTokens,
				output: totalOutputTokens,
			},
			iterations: maxIterations,
			toolCallsExecuted,
		};
	}

	function getConversationHistory(): Message[] {
		return workingMemory.getMessages();
	}

	function clearHistory(): void {
		workingMemory.clear();
		logger.info('Conversation history cleared');
	}

	return {
		processMessage,
		getConversationHistory,
		clearHistory,
	};
}
