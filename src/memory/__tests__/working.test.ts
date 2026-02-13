import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../../llm/types.js';
import { createWorkingMemory, estimateTokens } from '../working.js';

describe('estimateTokens', () => {
	it('estimates tokens based on character count', () => {
		// ~4 chars per token
		expect(estimateTokens('hello world')).toBeGreaterThan(0);
		expect(estimateTokens('a'.repeat(100))).toBe(25);
	});
});

describe('WorkingMemory', () => {
	let memory: ReturnType<typeof createWorkingMemory>;

	beforeEach(() => {
		memory = createWorkingMemory({ maxTokens: 1000 });
	});

	it('adds and retrieves messages', () => {
		const msg: Message = { role: 'user', content: 'Hello' };
		memory.addMessage(msg);

		const messages = memory.getMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toBe('Hello');
	});

	it('tracks token count', () => {
		memory.addMessage({ role: 'user', content: 'Hello world' });
		expect(memory.getTokenCount()).toBeGreaterThan(0);
	});

	it('accumulates token count across messages', () => {
		memory.addMessage({ role: 'user', content: 'Hello' });
		const first = memory.getTokenCount();

		memory.addMessage({ role: 'assistant', content: 'Hi there!' });
		expect(memory.getTokenCount()).toBeGreaterThan(first);
	});

	it('clears all messages and token count', () => {
		memory.addMessage({ role: 'user', content: 'Hello' });
		memory.addMessage({ role: 'assistant', content: 'Hi' });

		memory.clear();

		expect(memory.getMessages()).toHaveLength(0);
		expect(memory.getTokenCount()).toBe(0);
	});

	it('compresses when above threshold', async () => {
		// Use very low maxTokens to trigger compression
		const smallMemory = createWorkingMemory({ maxTokens: 50, compressThreshold: 0.5 });

		// Add enough messages to exceed threshold
		for (let i = 0; i < 10; i++) {
			smallMemory.addMessage({
				role: i % 2 === 0 ? 'user' : 'assistant',
				content: `This is message number ${i} with some extra content to increase token count.`,
			});
		}

		const beforeCount = smallMemory.getMessages().length;

		await smallMemory.compress(async (msgs) => {
			return `Summary of ${msgs.length} messages`;
		});

		// After compression, should have fewer messages
		expect(smallMemory.getMessages().length).toBeLessThan(beforeCount);

		// First message should be the summary
		const messages = smallMemory.getMessages();
		expect(messages[0]?.content).toContain('Previous conversation summary');
	});

	it('does not compress when below threshold', async () => {
		memory.addMessage({ role: 'user', content: 'Short' });

		const summarizer = async () => 'summary';
		await memory.compress(summarizer);

		// Should still have the original message
		expect(memory.getMessages()).toHaveLength(1);
		expect(memory.getMessages()[0]?.content).toBe('Short');
	});

	it('returns a copy of messages (immutable)', () => {
		memory.addMessage({ role: 'user', content: 'Hello' });

		const messages1 = memory.getMessages();
		const messages2 = memory.getMessages();

		expect(messages1).not.toBe(messages2);
		expect(messages1).toEqual(messages2);
	});
});
