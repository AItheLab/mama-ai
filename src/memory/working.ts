import type { Message } from '../llm/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('memory:working');

/** Simple token estimation: ~4 chars per token (rough approximation) */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: Message): number {
	let tokens = estimateTokens(msg.content);
	tokens += 4; // Role overhead
	if (msg.toolCalls) {
		for (const tc of msg.toolCalls) {
			tokens += estimateTokens(JSON.stringify(tc));
		}
	}
	return tokens;
}

interface WorkingMemoryOptions {
	maxTokens: number;
	compressThreshold?: number; // Percentage (0-1) of maxTokens to trigger compression
}

interface WorkingMemory {
	addMessage(msg: Message): void;
	getMessages(): Message[];
	getTokenCount(): number;
	compress(summarizer: (messages: Message[]) => Promise<string>): Promise<void>;
	clear(): void;
	getSystemInjection(): string[];
}

/**
 * Manages the conversation context window for LLM requests.
 * Handles token counting and progressive summarization.
 */
export function createWorkingMemory(options: WorkingMemoryOptions): WorkingMemory {
	const maxTokens = options.maxTokens;
	const compressThreshold = options.compressThreshold ?? 0.75;
	const messages: Message[] = [];
	const memoryInjections: string[] = []; // Injected from episodic/consolidated memory
	let totalTokens = 0;

	function addMessage(msg: Message): void {
		const tokens = estimateMessageTokens(msg);
		messages.push(msg);
		totalTokens += tokens;

		logger.debug('Message added to working memory', {
			role: msg.role,
			tokens,
			totalTokens,
			messageCount: messages.length,
		});
	}

	function getMessages(): Message[] {
		return [...messages];
	}

	function getTokenCount(): number {
		return totalTokens;
	}

	async function compress(summarizer: (messages: Message[]) => Promise<string>): Promise<void> {
		if (totalTokens < maxTokens * compressThreshold) return;

		// Keep the last few messages intact, compress older ones
		const keepCount = Math.min(4, messages.length);
		const toCompress = messages.slice(0, messages.length - keepCount);
		const toKeep = messages.slice(messages.length - keepCount);

		if (toCompress.length === 0) return;

		logger.info('Compressing working memory', {
			compressing: toCompress.length,
			keeping: toKeep.length,
		});

		const summary = await summarizer(toCompress);

		// Replace with summary message + kept messages
		messages.length = 0;
		messages.push({
			role: 'system',
			content: `[Previous conversation summary]: ${summary}`,
		});
		messages.push(...toKeep);

		// Recalculate tokens
		totalTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

		logger.info('Working memory compressed', {
			newTokenCount: totalTokens,
			messageCount: messages.length,
		});
	}

	function clear(): void {
		messages.length = 0;
		memoryInjections.length = 0;
		totalTokens = 0;
	}

	function getSystemInjection(): string[] {
		return [...memoryInjections];
	}

	return {
		addMessage,
		getMessages,
		getTokenCount,
		compress,
		clear,
		getSystemInjection,
	};
}

export { estimateTokens };
