import Anthropic from '@anthropic-ai/sdk';
import type {
	ContentBlockParam,
	MessageParam,
	ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import { createLogger } from '../../utils/logger.js';
import type { LLMProviderInterface, LLMRequest, LLMResponse, Message, ToolCall } from '../types.js';

const logger = createLogger('llm:claude');

interface ClaudeProviderConfig {
	apiKey: string;
	defaultModel: string;
}

function convertMessages(messages: Message[]): MessageParam[] {
	const result: MessageParam[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') continue; // System prompt handled separately

		if (msg.role === 'tool') {
			// Tool results go as user messages with tool_result content blocks
			const toolResultBlock: ToolResultBlockParam = {
				type: 'tool_result',
				tool_use_id: msg.toolResultId ?? '',
				content: msg.content,
			};
			result.push({ role: 'user', content: [toolResultBlock] });
			continue;
		}

		if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
			// Assistant message with tool calls
			const content: ContentBlockParam[] = [];
			if (msg.content) {
				content.push({ type: 'text', text: msg.content });
			}
			for (const tc of msg.toolCalls) {
				content.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.name,
					input: tc.arguments,
				});
			}
			result.push({ role: 'assistant', content });
			continue;
		}

		result.push({
			role: msg.role as 'user' | 'assistant',
			content: msg.content,
		});
	}

	return result;
}

function mapFinishReason(stopReason: string | null): LLMResponse['finishReason'] {
	switch (stopReason) {
		case 'end_turn':
			return 'end';
		case 'tool_use':
			return 'tool_use';
		case 'max_tokens':
			return 'max_tokens';
		default:
			return 'end';
	}
}

/**
 * Creates a Claude (Anthropic) LLM provider.
 */
export function createClaudeProvider(config: ClaudeProviderConfig): LLMProviderInterface {
	const client = new Anthropic({ apiKey: config.apiKey });

	async function complete(request: LLMRequest): Promise<LLMResponse> {
		const model = request.model ?? config.defaultModel;
		const messages = convertMessages(request.messages);
		const startTime = Date.now();

		logger.debug('Claude request', { model, messageCount: messages.length });

		const params: Anthropic.MessageCreateParams = {
			model,
			messages,
			max_tokens: request.maxTokens ?? 4096,
		};

		if (request.systemPrompt) {
			params.system = request.systemPrompt;
		}

		if (request.temperature !== undefined) {
			params.temperature = request.temperature;
		}

		if (request.tools && request.tools.length > 0) {
			params.tools = request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters as Anthropic.Tool.InputSchema,
			}));
		}

		const response = await client.messages.create(params);
		const latencyMs = Date.now() - startTime;

		// Extract content and tool calls
		let textContent = '';
		const toolCalls: ToolCall[] = [];

		for (const block of response.content) {
			if (block.type === 'text') {
				textContent += block.text;
			} else if (block.type === 'tool_use') {
				toolCalls.push({
					id: block.id,
					name: block.name,
					arguments: block.input as Record<string, unknown>,
				});
			}
		}

		logger.debug('Claude response', {
			model: response.model,
			latencyMs,
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
			stopReason: response.stop_reason,
		});

		return {
			content: textContent,
			toolCalls,
			usage: {
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
			},
			model: response.model,
			provider: 'claude',
			finishReason: mapFinishReason(response.stop_reason),
		};
	}

	async function isAvailable(): Promise<boolean> {
		return config.apiKey.length > 0;
	}

	return {
		name: 'claude',
		complete,
		isAvailable,
	};
}
