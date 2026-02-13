import { createLogger } from '../utils/logger.js';

const logger = createLogger('memory:embeddings');

export interface EmbeddingService {
	embed(text: string): Promise<Float32Array>;
	embedBatch(texts: string[]): Promise<Float32Array[]>;
	clearCache(): void;
	getCacheSize(): number;
}

interface EmbeddingServiceOptions {
	embedder: (text: string) => Promise<number[] | Float32Array>;
}

function normalizeEmbedding(value: number[] | Float32Array): Float32Array {
	return value instanceof Float32Array ? value : Float32Array.from(value);
}

/**
 * Creates an embedding helper with memoization for repeated strings.
 */
export function createEmbeddingService(options: EmbeddingServiceOptions): EmbeddingService {
	const cache = new Map<string, Float32Array>();

	async function embed(text: string): Promise<Float32Array> {
		const key = text.trim();
		if (cache.has(key)) {
			const cached = cache.get(key);
			if (cached) {
				return cached;
			}
		}

		const value = await options.embedder(key);
		const embedding = normalizeEmbedding(value);
		cache.set(key, embedding);

		logger.debug('Embedding generated', {
			textLength: key.length,
			dimensions: embedding.length,
			cacheSize: cache.size,
		});

		return embedding;
	}

	async function embedBatch(texts: string[]): Promise<Float32Array[]> {
		const unique = [...new Set(texts.map((item) => item.trim()))];
		await Promise.all(unique.map((text) => embed(text)));
		return texts.map((text) => {
			const cached = cache.get(text.trim());
			if (!cached) {
				throw new Error('Embedding cache inconsistency');
			}
			return cached;
		});
	}

	function clearCache(): void {
		cache.clear();
	}

	function getCacheSize(): number {
		return cache.size;
	}

	return {
		embed,
		embedBatch,
		clearCache,
		getCacheSize,
	};
}
