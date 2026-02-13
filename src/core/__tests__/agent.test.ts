import { describe, expect, it, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '../../llm/types.js';
import { createSoul } from '../../memory/soul.js';
import { createWorkingMemory } from '../../memory/working.js';
import { createAgent } from '../agent.js';
import { buildSystemPrompt } from '../context.js';

function createMockRouter() {
	const mockComplete = vi.fn<(req: LLMRequest) => Promise<LLMResponse>>().mockResolvedValue({
		content: 'Hello! How can I help you?',
		toolCalls: [],
		usage: { inputTokens: 50, outputTokens: 30 },
		model: 'claude-sonnet-4-20250514',
		provider: 'claude',
		finishReason: 'end',
	});

	return {
		complete: mockComplete,
		route: vi.fn(),
		getCostTracker: vi.fn(),
	};
}

describe('buildSystemPrompt', () => {
	it('includes soul content', () => {
		const prompt = buildSystemPrompt('I am Mama');
		expect(prompt).toContain('I am Mama');
	});

	it('includes memories when provided', () => {
		const prompt = buildSystemPrompt('I am Mama', ['User likes coffee', 'User works at 9am']);
		expect(prompt).toContain('User likes coffee');
		expect(prompt).toContain('User works at 9am');
		expect(prompt).toContain('Relevant Memories');
	});

	it('includes guidelines', () => {
		const prompt = buildSystemPrompt('Soul');
		expect(prompt).toContain('concise');
	});
});

describe('Agent', () => {
	it('processes a message and returns a response', async () => {
		const router = createMockRouter();
		const workingMemory = createWorkingMemory({ maxTokens: 4000 });
		const soul = createSoul({
			soulPath: '/nonexistent',
			userName: 'TestUser',
			agentName: 'TestMama',
		});

		const agent = createAgent({ router, workingMemory, soul });
		const response = await agent.processMessage('Hello Mama!', 'terminal');

		expect(response.content).toBe('Hello! How can I help you?');
		expect(response.model).toBe('claude-sonnet-4-20250514');
		expect(response.provider).toBe('claude');
		expect(response.tokenUsage.input).toBe(50);
		expect(response.tokenUsage.output).toBe(30);
	});

	it('accumulates conversation history', async () => {
		const router = createMockRouter();
		const workingMemory = createWorkingMemory({ maxTokens: 4000 });
		const soul = createSoul({
			soulPath: '/nonexistent',
			userName: 'TestUser',
			agentName: 'TestMama',
		});

		const agent = createAgent({ router, workingMemory, soul });

		await agent.processMessage('First message', 'terminal');
		await agent.processMessage('Second message', 'terminal');

		const history = agent.getConversationHistory();
		// 2 user messages + 2 assistant responses = 4
		expect(history).toHaveLength(4);
		expect(history[0]?.role).toBe('user');
		expect(history[1]?.role).toBe('assistant');
		expect(history[2]?.role).toBe('user');
		expect(history[3]?.role).toBe('assistant');
	});

	it('sends system prompt with soul content', async () => {
		const router = createMockRouter();
		const workingMemory = createWorkingMemory({ maxTokens: 4000 });
		const soul = createSoul({
			soulPath: '/nonexistent',
			userName: 'Alex',
			agentName: 'Mama',
		});

		const agent = createAgent({ router, workingMemory, soul });
		await agent.processMessage('Hi', 'terminal');

		const request = router.complete.mock.calls[0]?.[0];
		expect(request.systemPrompt).toContain('Mama');
		expect(request.systemPrompt).toContain('Alex');
	});

	it('clears conversation history', async () => {
		const router = createMockRouter();
		const workingMemory = createWorkingMemory({ maxTokens: 4000 });
		const soul = createSoul({
			soulPath: '/nonexistent',
			userName: 'Alex',
			agentName: 'Mama',
		});

		const agent = createAgent({ router, workingMemory, soul });
		await agent.processMessage('Hello', 'terminal');
		expect(agent.getConversationHistory()).toHaveLength(2);

		agent.clearHistory();
		expect(agent.getConversationHistory()).toHaveLength(0);
	});
});
