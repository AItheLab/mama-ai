import type { SQLInputValue } from 'node:sqlite';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import type { EmbeddingService } from './embeddings.js';
import type { MemoryStore } from './store.js';

const logger = createLogger('memory:episodic');

const STOPWORDS = new Set([
	'the',
	'this',
	'that',
	'with',
	'from',
	'have',
	'what',
	'when',
	'where',
	'which',
	'while',
	'about',
	'there',
	'their',
	'your',
	'you',
	'and',
	'for',
	'into',
	'just',
	'than',
	'then',
	'were',
	'will',
	'would',
	'could',
	'should',
	'been',
	'they',
	'them',
	'also',
	'please',
]);

export type EpisodeRole = 'system' | 'user' | 'assistant' | 'tool';
export type Importance = 'low' | 'medium' | 'high';
export type EmotionalTone = 'neutral' | 'positive' | 'negative';

export interface EpisodeMetadata {
	topics?: string[];
	entities?: string[];
	importance?: Importance;
	emotionalTone?: EmotionalTone;
	[key: string]: unknown;
}

export interface Episode {
	id: string;
	timestamp: Date;
	channel: string;
	role: string;
	content: string;
	embedding: Float32Array | null;
	metadata: EpisodeMetadata;
	consolidated: boolean;
}

export interface NewEpisode {
	timestamp?: Date;
	channel: string;
	role: EpisodeRole | string;
	content: string;
	metadata?: EpisodeMetadata;
	consolidated?: boolean;
}

export interface SearchOptions {
	topK?: number;
	start?: Date;
	end?: Date;
	channel?: string;
	role?: string;
}

export interface HybridOptions extends SearchOptions {
	semanticWeight?: number;
	temporalWeight?: number;
	topicWeight?: number;
}

export interface EpisodicMemory {
	storeEpisode(episode: NewEpisode): Promise<string>;
	searchSemantic(query: string, options?: SearchOptions): Promise<Episode[]>;
	searchTemporal(start: Date, end: Date): Promise<Episode[]>;
	searchHybrid(query: string, options?: HybridOptions): Promise<Episode[]>;
	getRecent(limit: number): Promise<Episode[]>;
	markConsolidated(ids: string[]): Promise<void>;
}

interface EpisodicMemoryOptions {
	store: MemoryStore;
	embeddings: EmbeddingService;
	defaultTopK?: number;
}

interface EpisodeRow {
	id: string;
	timestamp: string;
	channel: string;
	role: string;
	content: string;
	embedding: Uint8Array | null;
	metadata: string | null;
	consolidated: number | boolean;
}

function serializeEmbedding(embedding: Float32Array | null): Uint8Array | null {
	if (!embedding) return null;
	return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function deserializeEmbedding(value: Uint8Array | null): Float32Array | null {
	if (!value || value.byteLength < 4) return null;
	const bytes = new Uint8Array(value.byteLength);
	bytes.set(value);
	const dimensions = Math.floor(bytes.byteLength / 4);
	return new Float32Array(bytes.buffer, 0, dimensions);
}

function parseMetadata(value: string | null): EpisodeMetadata {
	if (!value) return {};
	try {
		return JSON.parse(value) as EpisodeMetadata;
	} catch {
		return {};
	}
}

function mapRowToEpisode(row: EpisodeRow): Episode {
	return {
		id: row.id,
		timestamp: new Date(row.timestamp),
		channel: row.channel,
		role: row.role,
		content: row.content,
		embedding: deserializeEmbedding(row.embedding),
		metadata: parseMetadata(row.metadata),
		consolidated: Boolean(row.consolidated),
	};
}

function normalizeTopicToken(token: string): string {
	return token.toLowerCase();
}

function extractTopics(content: string): string[] {
	const tokens = content
		.toLowerCase()
		.match(/[a-z0-9]{4,}/g)
		?.map((token) => token.trim())
		.filter((token) => token.length >= 4 && !STOPWORDS.has(token))
		.map((token) => normalizeTopicToken(token));
	if (!tokens) return [];

	const frequencies = new Map<string, number>();
	for (const token of tokens) {
		frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
	}

	return [...frequencies.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 6)
		.map(([token]) => token);
}

function extractEntities(content: string): string[] {
	const entities = content.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) ?? [];
	return [...new Set(entities)].slice(0, 8);
}

function detectImportance(content: string): Importance {
	const normalized = content.toLowerCase();
	if (
		normalized.includes('urgent') ||
		normalized.includes('critical') ||
		normalized.includes('security') ||
		normalized.includes('incident')
	) {
		return 'high';
	}
	if (content.length > 280) {
		return 'high';
	}
	if (content.length > 120) {
		return 'medium';
	}
	return 'low';
}

function detectEmotionalTone(content: string): EmotionalTone {
	const normalized = content.toLowerCase();
	const positive = ['great', 'thanks', 'good', 'awesome', 'love', 'nice', 'perfect'];
	const negative = ['error', 'fail', 'broken', 'angry', 'upset', 'problem', 'issue'];

	if (positive.some((token) => normalized.includes(token))) return 'positive';
	if (negative.some((token) => normalized.includes(token))) return 'negative';
	return 'neutral';
}

function enrichMetadata(content: string, metadata: EpisodeMetadata | undefined): EpisodeMetadata {
	const providedTopics = Array.isArray(metadata?.topics)
		? metadata.topics.map((topic) => normalizeTopicToken(String(topic)))
		: [];
	const providedEntities = Array.isArray(metadata?.entities)
		? metadata.entities.map((entity) => String(entity))
		: [];

	const topics = [...new Set([...providedTopics, ...extractTopics(content)])].slice(0, 10);
	const entities = [...new Set([...providedEntities, ...extractEntities(content)])].slice(0, 10);

	return {
		...metadata,
		topics,
		entities,
		importance: metadata?.importance ?? detectImportance(content),
		emotionalTone: metadata?.emotionalTone ?? detectEmotionalTone(content),
	};
}

function cosineSimilarity(a: Float32Array | null, b: Float32Array): number {
	if (!a || a.length === 0 || b.length === 0) return 0;
	const dimensions = Math.min(a.length, b.length);
	if (dimensions === 0) return 0;

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < dimensions; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}

	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildQueryFilters(options: SearchOptions): {
	whereClause: string;
	params: SQLInputValue[];
} {
	const filters: string[] = [];
	const params: SQLInputValue[] = [];

	if (options.start) {
		filters.push('timestamp >= ?');
		params.push(options.start.toISOString());
	}
	if (options.end) {
		filters.push('timestamp <= ?');
		params.push(options.end.toISOString());
	}
	if (options.channel) {
		filters.push('channel = ?');
		params.push(options.channel);
	}
	if (options.role) {
		filters.push('role = ?');
		params.push(options.role);
	}

	return {
		whereClause: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '',
		params,
	};
}

function queryTokens(query: string): string[] {
	return (
		query
			.toLowerCase()
			.match(/[a-z0-9]{3,}/g)
			?.filter((token) => !STOPWORDS.has(token))
			.slice(0, 8) ?? []
	);
}

export function createEpisodicMemory(options: EpisodicMemoryOptions): EpisodicMemory {
	const topKDefault = options.defaultTopK ?? 10;

	function getCandidates(searchOptions: SearchOptions = {}): Episode[] {
		const filters = buildQueryFilters(searchOptions);
		const rows = options.store.all<EpisodeRow>(
			`SELECT id, timestamp, channel, role, content, embedding, metadata, consolidated
			 FROM episodes
			 ${filters.whereClause}
			 ORDER BY timestamp DESC
			 LIMIT 3000`,
			filters.params,
		);

		return rows.map(mapRowToEpisode);
	}

	async function storeEpisode(episode: NewEpisode): Promise<string> {
		const id = uuidv4();
		const timestamp = (episode.timestamp ?? new Date()).toISOString();
		const metadata = enrichMetadata(episode.content, episode.metadata);

		let embedding: Float32Array | null = null;
		try {
			embedding = await options.embeddings.embed(episode.content);
		} catch (error) {
			logger.warn('Failed to generate embedding for episode', {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		options.store.run(
			`INSERT INTO episodes (id, timestamp, channel, role, content, embedding, metadata, consolidated)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				timestamp,
				episode.channel,
				episode.role,
				episode.content,
				serializeEmbedding(embedding),
				JSON.stringify(metadata),
				episode.consolidated ? 1 : 0,
			],
		);

		return id;
	}

	async function searchSemantic(
		query: string,
		searchOptions: SearchOptions = {},
	): Promise<Episode[]> {
		const queryEmbedding = await options.embeddings.embed(query);
		const topK = searchOptions.topK ?? topKDefault;
		const candidates = getCandidates(searchOptions);

		return candidates
			.map((episode) => ({
				episode,
				score: cosineSimilarity(episode.embedding, queryEmbedding),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map((item) => item.episode);
	}

	async function searchTemporal(start: Date, end: Date): Promise<Episode[]> {
		const rows = options.store.all<EpisodeRow>(
			`SELECT id, timestamp, channel, role, content, embedding, metadata, consolidated
			 FROM episodes
			 WHERE timestamp >= ? AND timestamp <= ?
			 ORDER BY timestamp DESC`,
			[start.toISOString(), end.toISOString()],
		);

		return rows.map(mapRowToEpisode);
	}

	async function searchHybrid(
		query: string,
		hybridOptions: HybridOptions = {},
	): Promise<Episode[]> {
		const queryEmbedding = await options.embeddings.embed(query);
		const nowMs = Date.now();
		const topicTokens = queryTokens(query);
		const topK = hybridOptions.topK ?? topKDefault;
		const semanticWeight = hybridOptions.semanticWeight ?? 0.65;
		const temporalWeight = hybridOptions.temporalWeight ?? 0.25;
		const topicWeight = hybridOptions.topicWeight ?? 0.1;
		const candidates = getCandidates(hybridOptions);

		return candidates
			.map((episode) => {
				const semanticScore = cosineSimilarity(episode.embedding, queryEmbedding);
				const ageDays = Math.max(0, (nowMs - episode.timestamp.getTime()) / (24 * 60 * 60 * 1000));
				const temporalScore = 1 / (1 + ageDays);
				const topics = episode.metadata.topics ?? [];
				const topicHits = topicTokens.filter((token) => topics.includes(token)).length;
				const topicScore = topicTokens.length > 0 ? topicHits / topicTokens.length : 0;
				const score =
					semanticWeight * semanticScore +
					temporalWeight * temporalScore +
					topicWeight * topicScore;
				return {
					episode,
					score,
				};
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map((item) => item.episode);
	}

	async function getRecent(limit: number): Promise<Episode[]> {
		const rows = options.store.all<EpisodeRow>(
			`SELECT id, timestamp, channel, role, content, embedding, metadata, consolidated
			 FROM episodes
			 ORDER BY timestamp DESC
			 LIMIT ?`,
			[Math.max(1, limit)],
		);
		return rows.map(mapRowToEpisode);
	}

	async function markConsolidated(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => '?').join(', ');
		options.store.run(`UPDATE episodes SET consolidated = 1 WHERE id IN (${placeholders})`, ids);
	}

	return {
		storeEpisode,
		searchSemantic,
		searchTemporal,
		searchHybrid,
		getRecent,
		markConsolidated,
	};
}
