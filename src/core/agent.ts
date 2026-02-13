import type { createLLMRouter } from '../llm/router.js';
import type { LLMRequest, Message } from '../llm/types.js';
import type { createSoul } from '../memory/soul.js';
import type { createWorkingMemory } from '../memory/working.js';
import { createLogger } from '../utils/logger.js';
import { buildSystemPrompt } from './context.js';
import type { AgentResponse, ChannelName } from './types.js';

const logger = createLogger('core:agent');

interface AgentDeps {
	router: ReturnType<typeof createLLMRouter>;
	workingMemory: ReturnType<typeof createWorkingMemory>;
	soul: ReturnType<typeof createSoul>;
}

interface Agent {
	processMessage(input: string, channel: ChannelName): Promise<AgentResponse>;
	getConversationHistory(): Message[];
	clearHistory(): void;
}

/**
 * Creates the main Mama agent.
 * Processes user messages through the LLM router with context management.
 */
export function createAgent(deps: AgentDeps): Agent {
	const { router, workingMemory, soul } = deps;

	async function processMessage(input: string, channel: ChannelName): Promise<AgentResponse> {
		logger.info('Processing message', { channel, inputLength: input.length });

		// Add user message to working memory
		const userMessage: Message = { role: 'user', content: input };
		workingMemory.addMessage(userMessage);

		// Build system prompt
		const systemPrompt = buildSystemPrompt(
			soul.getSoulPrompt(),
			workingMemory.getSystemInjection(),
		);

		// Build LLM request
		const request: LLMRequest = {
			messages: workingMemory.getMessages(),
			systemPrompt,
			taskType: 'general',
			maxTokens: 4096,
		};

		// Send to LLM
		const response = await router.complete(request);

		// Add assistant response to working memory
		const assistantMessage: Message = {
			role: 'assistant',
			content: response.content,
			toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
		};
		workingMemory.addMessage(assistantMessage);

		logger.info('Message processed', {
			channel,
			model: response.model,
			provider: response.provider,
			inputTokens: response.usage.inputTokens,
			outputTokens: response.usage.outputTokens,
		});

		return {
			content: response.content,
			model: response.model,
			provider: response.provider,
			tokenUsage: {
				input: response.usage.inputTokens,
				output: response.usage.outputTokens,
			},
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
