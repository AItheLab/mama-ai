import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/loader.js';
import type { MamaConfig } from '../../config/schema.js';
import { createLLMRouter } from '../router.js';
import type { LLMProviderInterface, LLMRequest, LLMResponse } from '../types.js';

function createMockProvider(name: 'claude' | 'ollama'): LLMProviderInterface {
	return {
		name,
		complete: vi.fn<(req: LLMRequest) => Promise<LLMResponse>>().mockResolvedValue({
			content: `Response from ${name}`,
			toolCalls: [],
			usage: { inputTokens: 100, outputTokens: 50 },
			model: name === 'claude' ? 'claude-sonnet-4-20250514' : 'minimax-m2.5:cloud',
			provider: name,
			finishReason: 'end',
		}),
		isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
	};
}

function getTestConfig(): MamaConfig {
	const result = loadConfig('/nonexistent');
	if (!result.ok) throw result.error;
	return result.value;
}

describe('LLMRouter', () => {
	it('routes complex_reasoning to Ollama smart model', () => {
		const config = getTestConfig();
		const router = createLLMRouter({ config });

		const decision = router.route('complex_reasoning');
		expect(decision.provider).toBe('ollama');
		expect(decision.model).toBe('minimax-m2.5:cloud');
	});

	it('routes simple_tasks to Ollama fast model', () => {
		const config = getTestConfig();
		const router = createLLMRouter({ config });

		const decision = router.route('simple_tasks');
		expect(decision.provider).toBe('ollama');
		expect(decision.model).toBe('gemini-3-flash-preview:cloud');
	});

	it('routes embeddings to Ollama embedding model', () => {
		const config = getTestConfig();
		const router = createLLMRouter({ config });

		const decision = router.route('embeddings');
		expect(decision.provider).toBe('ollama');
		expect(decision.model).toBe('nomic-embed-text');
	});

	it('routes general tasks to default Ollama model', () => {
		const config = getTestConfig();
		const router = createLLMRouter({ config });

		const decision = router.route('general');
		expect(decision.provider).toBe('ollama');
		expect(decision.model).toBe('minimax-m2.5:cloud');
	});

	it('completes request via primary provider', async () => {
		const config = getTestConfig();
		const ollama = createMockProvider('ollama');
		const router = createLLMRouter({ config, ollamaProvider: ollama });

		const response = await router.complete({
			messages: [{ role: 'user', content: 'Hello' }],
			taskType: 'simple_tasks',
		});

		expect(response.provider).toBe('ollama');
		expect(response.content).toBe('Response from ollama');
		expect(ollama.complete).toHaveBeenCalledOnce();
		expect((ollama.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].model).toBe(
			'gemini-3-flash-preview:cloud',
		);
	});

	it('falls back to Claude when Ollama fails', async () => {
		const config = getTestConfig();
		const claude = createMockProvider('claude');
		const ollama = createMockProvider('ollama');

		(ollama.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Ollama down'));

		const router = createLLMRouter({
			config,
			claudeProvider: claude,
			ollamaProvider: ollama,
		});

		const response = await router.complete({
			messages: [{ role: 'user', content: 'Hello' }],
			taskType: 'complex_reasoning',
		});

		expect(response.provider).toBe('claude');
		expect(claude.complete).toHaveBeenCalledOnce();
	});

	it('throws when all providers fail', async () => {
		const config = getTestConfig();
		const claude = createMockProvider('claude');
		const ollama = createMockProvider('ollama');

		(claude.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Claude down'));
		(ollama.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Ollama down'));

		const router = createLLMRouter({
			config,
			claudeProvider: claude,
			ollamaProvider: ollama,
		});

		await expect(
			router.complete({
				messages: [{ role: 'user', content: 'Hello' }],
			}),
		).rejects.toThrow('All LLM providers failed');
	});

	it('tracks cost after completion', async () => {
		const config = getTestConfig();
		const ollama = createMockProvider('ollama');
		const router = createLLMRouter({ config, ollamaProvider: ollama });

		await router.complete({
			messages: [{ role: 'user', content: 'Hello' }],
		});

		const costTracker = router.getCostTracker();
		expect(costTracker.getRecords()).toHaveLength(1);
		expect(costTracker.getTotalCost()).toBeGreaterThanOrEqual(0);
	});
});
