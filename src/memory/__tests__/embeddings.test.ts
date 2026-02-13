import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingService } from '../embeddings.js';

describe('embedding service (Task 3.2)', () => {
	it('caches repeated embedding requests', async () => {
		const embedder = vi
			.fn<(text: string) => Promise<number[]>>()
			.mockImplementation(async (text) => [text.length, text.length + 1]);
		const service = createEmbeddingService({ embedder });

		const a = await service.embed('hello');
		const b = await service.embed('hello');

		expect(embedder).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
		expect(service.getCacheSize()).toBe(1);
	});

	it('deduplicates embedBatch while preserving input order', async () => {
		const embedder = vi
			.fn<(text: string) => Promise<number[]>>()
			.mockImplementation(async (text) => {
				if (text.includes('project')) return [1, 0, 1];
				return [0, 1, 0];
			});
		const service = createEmbeddingService({ embedder });

		const vectors = await service.embedBatch(['project alpha', 'notes', 'project alpha']);

		expect(embedder).toHaveBeenCalledTimes(2);
		expect(vectors).toHaveLength(3);
		expect(Array.from(vectors[0] ?? [])).toEqual([1, 0, 1]);
		expect(Array.from(vectors[2] ?? [])).toEqual([1, 0, 1]);
	});
});
