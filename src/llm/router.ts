import type { MamaConfig } from '../config/schema.js';
import { createLogger } from '../utils/logger.js';
import { createCostTracker } from './cost-tracker.js';
import type {
	LLMProviderInterface,
	LLMRequest,
	LLMResponse,
	RoutingDecision,
	TaskType,
} from './types.js';

const logger = createLogger('llm:router');

interface LLMRouter {
	complete(request: LLMRequest): Promise<LLMResponse>;
	route(taskType: TaskType): RoutingDecision;
	getCostTracker(): ReturnType<typeof createCostTracker>;
}

interface RouterDeps {
	config: MamaConfig;
	claudeProvider?: LLMProviderInterface;
	ollamaProvider?: LLMProviderInterface;
}

function getModelForTask(
	config: MamaConfig,
	provider: 'claude' | 'ollama',
	taskType: TaskType,
): string {
	if (provider === 'claude') {
		return config.llm.providers.claude.defaultModel;
	}

	const ollama = config.llm.providers.ollama;
	switch (taskType) {
		case 'complex_reasoning':
		case 'code_generation':
		case 'memory_consolidation':
			return ollama.smartModel;
		case 'simple_tasks':
		case 'private_content':
			return ollama.fastModel;
		case 'embeddings':
			return ollama.embeddingModel;
		default:
			return ollama.defaultModel;
	}
}

/**
 * Creates an LLM router that intelligently selects providers based on task type.
 * Includes fallback logic and cost tracking.
 */
export function createLLMRouter(deps: RouterDeps): LLMRouter {
	const { config } = deps;
	const costTracker = createCostTracker();
	const providers = new Map<string, LLMProviderInterface>();

	if (deps.claudeProvider) providers.set('claude', deps.claudeProvider);
	if (deps.ollamaProvider) providers.set('ollama', deps.ollamaProvider);

	function route(taskType: TaskType): RoutingDecision {
		const routing = config.llm.routing;

		const routingMap: Record<TaskType, 'claude' | 'ollama'> = {
			complex_reasoning: routing.complexReasoning,
			code_generation: routing.codeGeneration,
			simple_tasks: routing.simpleTasks,
			embeddings: routing.embeddings,
			memory_consolidation: routing.memoryConsolidation,
			private_content: routing.privateContent,
			general: config.llm.defaultProvider,
		};

		const provider = routingMap[taskType] ?? config.llm.defaultProvider;
		const model = getModelForTask(config, provider, taskType);

		return {
			provider,
			model,
			reason: `Task type "${taskType}" routed to ${provider}/${model}`,
		};
	}

	async function complete(request: LLMRequest): Promise<LLMResponse> {
		const taskType = request.taskType ?? 'general';
		const decision = route(taskType);
		const startTime = Date.now();
		let primaryError: unknown;

		// Try primary provider
		const primary = providers.get(decision.provider);
		if (primary) {
			try {
				const response = await primary.complete({
					...request,
					model: request.model ?? decision.model,
				});

				const latencyMs = Date.now() - startTime;
				costTracker.record({
					provider: decision.provider,
					model: response.model,
					usage: response.usage,
					taskType,
					latencyMs,
				});

				logger.info('LLM request completed', {
					provider: decision.provider,
					model: response.model,
					taskType,
					latencyMs,
					inputTokens: response.usage.inputTokens,
					outputTokens: response.usage.outputTokens,
				});

				return response;
			} catch (err) {
				primaryError = err;
				logger.warn('Primary provider failed, trying fallback', {
					provider: decision.provider,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Fallback to the other provider
		const fallbackName = decision.provider === 'claude' ? 'ollama' : 'claude';
		const fallback = providers.get(fallbackName);

		if (fallback) {
			const fallbackModel = getModelForTask(config, fallbackName, taskType);

			try {
				const response = await fallback.complete({
					...request,
					model: request.model ?? fallbackModel,
				});

				const latencyMs = Date.now() - startTime;
				costTracker.record({
					provider: fallbackName,
					model: response.model,
					usage: response.usage,
					taskType,
					latencyMs,
				});

				logger.info('LLM request completed via fallback', {
					provider: fallbackName,
					model: response.model,
					taskType,
					latencyMs,
				});

				return response;
			} catch (err) {
				throw new Error(
					`All LLM providers failed. Last error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		if (primaryError) {
			throw new Error(
				`Primary provider "${decision.provider}" failed and no fallback provider is configured. Last error: ${
					primaryError instanceof Error ? primaryError.message : String(primaryError)
				}`,
			);
		}

		throw new Error('No LLM providers available');
	}

	return {
		complete,
		route,
		getCostTracker: () => costTracker,
	};
}
