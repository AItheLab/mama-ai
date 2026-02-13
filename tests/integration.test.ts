import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfig } from '../src/config/loader.js';
import { createAgent } from '../src/core/agent.js';
import { createLLMRouter } from '../src/llm/router.js';
import type { LLMProviderInterface, LLMRequest, LLMResponse } from '../src/llm/types.js';
import { createSoul } from '../src/memory/soul.js';
import { createWorkingMemory } from '../src/memory/working.js';

function createMockClaudeProvider(): LLMProviderInterface {
	let callCount = 0;
	return {
		name: 'claude',
		complete: vi.fn<(req: LLMRequest) => Promise<LLMResponse>>().mockImplementation(async (req) => {
			callCount++;
			const userMsg = req.messages.find((m) => m.role === 'user');
			const content = userMsg?.content.includes('name')
				? 'My name is Mama, your personal AI agent!'
				: `I understand. You said: "${userMsg?.content ?? ''}". How can I help you?`;

			return {
				content,
				toolCalls: [],
				usage: { inputTokens: 100 + callCount * 20, outputTokens: 50 + callCount * 10 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'end',
			};
		}),
		isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
	};
}

describe('Integration: Full Agent Flow', () => {
	beforeEach(() => {
		resetConfig();
	});

	it('loads config, creates agent, processes messages, and tracks history', async () => {
		// 1. Load config
		const configResult = loadConfig('/nonexistent/config.yaml');
		expect(configResult.ok).toBe(true);
		if (!configResult.ok) return;

		const config = configResult.value;
		expect(config.agent.name).toBe('Mama');

		// 2. Create mocked LLM provider
		const claudeProvider = createMockClaudeProvider();

		// 3. Create router with mock
		const router = createLLMRouter({
			config,
			claudeProvider,
		});

		// 4. Create working memory
		const workingMemory = createWorkingMemory({ maxTokens: 100000 });

		// 5. Create soul
		const soul = createSoul({
			soulPath: '/nonexistent/soul.md',
			userName: config.user.name,
			agentName: config.agent.name,
		});

		// 6. Create agent
		const agent = createAgent({ router, workingMemory, soul });

		// 7. Send first message
		const response1 = await agent.processMessage('Hello, Mama!', 'terminal');
		expect(response1.content).toContain('Hello, Mama!');
		expect(response1.provider).toBe('claude');
		expect(response1.model).toBe('claude-sonnet-4-20250514');

		// 8. Send second message
		const response2 = await agent.processMessage("What's your name?", 'terminal');
		expect(response2.content).toContain('Mama');

		// 9. Verify history accumulated
		const history = agent.getConversationHistory();
		expect(history).toHaveLength(4); // 2 user + 2 assistant

		expect(history[0]?.role).toBe('user');
		expect(history[0]?.content).toBe('Hello, Mama!');
		expect(history[1]?.role).toBe('assistant');
		expect(history[2]?.role).toBe('user');
		expect(history[2]?.content).toBe("What's your name?");
		expect(history[3]?.role).toBe('assistant');

		// 10. Verify token tracking
		expect(response1.tokenUsage.input).toBeGreaterThan(0);
		expect(response2.tokenUsage.output).toBeGreaterThan(0);

		// 11. Verify cost tracking
		const costTracker = router.getCostTracker();
		expect(costTracker.getRecords()).toHaveLength(2);
		expect(costTracker.getTotalCost()).toBeGreaterThan(0);

		// 12. Verify working memory token count increases
		expect(workingMemory.getTokenCount()).toBeGreaterThan(0);
	});

	it('continues conversation with context from previous messages', async () => {
		const configResult = loadConfig('/nonexistent');
		if (!configResult.ok) throw configResult.error;

		const claudeProvider: LLMProviderInterface = {
			name: 'claude',
			complete: vi
				.fn<(req: LLMRequest) => Promise<LLMResponse>>()
				.mockImplementation(async (req) => {
					// Verify that all previous messages are included
					return {
						content: `Received ${req.messages.length} messages in context`,
						toolCalls: [],
						usage: { inputTokens: 100, outputTokens: 50 },
						model: 'claude-sonnet-4-20250514',
						provider: 'claude',
						finishReason: 'end',
					};
				}),
			isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
		};

		const router = createLLMRouter({
			config: configResult.value,
			claudeProvider,
		});

		const agent = createAgent({
			router,
			workingMemory: createWorkingMemory({ maxTokens: 100000 }),
			soul: createSoul({
				soulPath: '/nonexistent',
				userName: 'Alex',
				agentName: 'Mama',
			}),
		});

		await agent.processMessage('Message 1', 'terminal');
		await agent.processMessage('Message 2', 'terminal');
		const response3 = await agent.processMessage('Message 3', 'terminal');

		// Third call should have 5 messages: 3 user + 2 assistant
		expect(response3.content).toBe('Received 5 messages in context');
	});

	it('agent clears history correctly', async () => {
		const configResult = loadConfig('/nonexistent');
		if (!configResult.ok) throw configResult.error;

		const claudeProvider = createMockClaudeProvider();
		const router = createLLMRouter({
			config: configResult.value,
			claudeProvider,
		});

		const workingMemory = createWorkingMemory({ maxTokens: 100000 });
		const agent = createAgent({
			router,
			workingMemory,
			soul: createSoul({
				soulPath: '/nonexistent',
				userName: 'Alex',
				agentName: 'Mama',
			}),
		});

		await agent.processMessage('Hello', 'terminal');
		expect(agent.getConversationHistory()).toHaveLength(2);

		agent.clearHistory();
		expect(agent.getConversationHistory()).toHaveLength(0);
		expect(workingMemory.getTokenCount()).toBe(0);
	});
});
