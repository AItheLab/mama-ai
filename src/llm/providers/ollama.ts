import { Ollama } from 'ollama';
import { createLogger } from '../../utils/logger.js';
import type { LLMProviderInterface, LLMRequest, LLMResponse, Message, ToolCall } from '../types.js';

const logger = createLogger('llm:ollama');

interface OllamaProviderConfig {
	host: string;
	apiKey?: string;
	defaultModel: string;
	embeddingModel: string;
}

export type OllamaProvider = LLMProviderInterface & {
	embed(text: string): Promise<number[]>;
};

function convertMessages(messages: Message[]): Array<{ role: string; content: string }> {
	return messages
		.filter((msg) => msg.role !== 'system')
		.map((msg) => ({
			role: msg.role === 'tool' ? 'user' : msg.role,
			content:
				msg.role === 'tool'
					? `[Tool Result (${msg.toolResultId ?? 'unknown'})]: ${msg.content}`
					: msg.content,
		}));
}

/**
 * Creates an Ollama (local LLM) provider with embedding support.
 */
export function createOllamaProvider(config: OllamaProviderConfig): OllamaProvider {
	const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined;
	const client = new Ollama({ host: config.host, headers });

	async function complete(request: LLMRequest): Promise<LLMResponse> {
		const model = request.model ?? config.defaultModel;
		const messages = convertMessages(request.messages);
		const startTime = Date.now();

		logger.debug('Ollama request', { model, messageCount: messages.length });

		const ollamaMessages = messages.map((m) => ({
			role: m.role as 'user' | 'assistant' | 'system',
			content: m.content,
		}));

		// Add system prompt as first message if provided
		if (request.systemPrompt) {
			ollamaMessages.unshift({ role: 'system', content: request.systemPrompt });
		}

		const params: Parameters<typeof client.chat>[0] = {
			model,
			messages: ollamaMessages,
			options: {},
		};

		if (request.temperature !== undefined && params.options) {
			params.options.temperature = request.temperature;
		}

		if (request.maxTokens && params.options) {
			params.options.num_predict = request.maxTokens;
		}

		// Tool support for compatible models
		if (request.tools && request.tools.length > 0) {
			params.tools = request.tools.map((tool) => ({
				type: 'function' as const,
				function: {
					name: tool.name,
					description: tool.description,
					// ToolDefinition.parameters is already a JSON Schema object.
					parameters: tool.parameters as Record<string, unknown>,
				},
			}));
		}

		const response = await client.chat(params);
		const latencyMs = Date.now() - startTime;

		// Extract tool calls if present
		const toolCalls: ToolCall[] = [];
		if (response.message.tool_calls) {
			for (const tc of response.message.tool_calls) {
				toolCalls.push({
					id: `ollama-${Date.now()}-${toolCalls.length}`,
					name: tc.function.name,
					arguments: tc.function.arguments as Record<string, unknown>,
				});
			}
		}

		const inputTokens = response.prompt_eval_count ?? 0;
		const outputTokens = response.eval_count ?? 0;

		logger.debug('Ollama response', {
			model,
			latencyMs,
			inputTokens,
			outputTokens,
		});

		return {
			content: response.message.content,
			toolCalls,
			usage: { inputTokens, outputTokens },
			model,
			provider: 'ollama',
			finishReason: toolCalls.length > 0 ? 'tool_use' : 'end',
		};
	}

	async function isAvailable(): Promise<boolean> {
		try {
			await client.list();
			return true;
		} catch {
			return false;
		}
	}

	async function embed(text: string): Promise<number[]> {
		const response = await client.embed({
			model: config.embeddingModel,
			input: text,
		});
		return response.embeddings[0] ?? [];
	}

	return {
		name: 'ollama',
		complete,
		isAvailable,
		embed,
	};
}
