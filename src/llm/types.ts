// src/llm/types.ts — LLM subsystem type definitions

/** Supported LLM providers */
export type LLMProvider = 'claude' | 'ollama';

/** Task types used for routing requests to the appropriate provider/model */
export type TaskType =
	| 'complex_reasoning'
	| 'code_generation'
	| 'simple_tasks'
	| 'embeddings'
	| 'memory_consolidation'
	| 'private_content'
	| 'general';

/** Role for messages in a conversation */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A message in the conversation */
export interface Message {
	role: MessageRole;
	content: string;
	toolCalls?: ToolCall[];
	/** For tool result messages — references the originating tool call */
	toolResultId?: string;
}

/** Tool definition for function calling (JSON Schema parameters) */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** A tool call returned by the LLM */
export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Request sent to an LLM provider */
export interface LLMRequest {
	messages: Message[];
	systemPrompt?: string;
	tools?: ToolDefinition[];
	/** Override the default model for this request */
	model?: string;
	temperature?: number;
	maxTokens?: number;
	/** Used by the router to select provider/model */
	taskType?: TaskType;
}

/** Response returned from an LLM provider */
export interface LLMResponse {
	content: string;
	toolCalls: ToolCall[];
	usage: TokenUsage;
	model: string;
	provider: LLMProvider;
	finishReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
}

/** Token usage counts for a single request */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
}

/** Persisted usage record for cost tracking and analytics */
export interface LLMUsageRecord {
	id: string;
	timestamp: Date;
	provider: LLMProvider;
	model: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	taskType: TaskType;
	latencyMs: number;
}

/** Result of the router deciding which provider/model handles a request */
export interface RoutingDecision {
	provider: LLMProvider;
	model: string;
	reason: string;
}

/** Interface that every LLM provider must implement */
export interface LLMProviderInterface {
	name: LLMProvider;
	complete(request: LLMRequest): Promise<LLMResponse>;
	isAvailable(): Promise<boolean>;
}
