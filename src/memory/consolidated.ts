import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import type { EmbeddingService } from './embeddings.js';
import type { MemoryStore } from './store.js';

const logger = createLogger('memory:consolidated');

export type MemoryCategory =
	| 'fact'
	| 'preference'
	| 'pattern'
	| 'goal'
	| 'relationship'
	| 'skill'
	| 'routine'
	| 'emotional'
	| 'project';

export interface ConsolidatedMemory {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	category: MemoryCategory;
	content: string;
	confidence: number;
	sourceEpisodes: string[];
	embedding: Float32Array | null;
	active: boolean;
	reinforcementCount: number;
	lastReinforcedAt: Date | null;
	contradictions: string[];
}

export interface NewConsolidatedMemory {
	category: MemoryCategory;
	content: string;
	confidence?: number;
	sourceEpisodes?: string[];
	active?: boolean;
	contradictions?: string[];
}

export interface ConsolidatedSearchOptions {
	topK?: number;
	minConfidence?: number;
	includeInactive?: boolean;
	category?: MemoryCategory;
}

export interface ConsolidatedMemoryStore {
	create(memory: NewConsolidatedMemory): Promise<string>;
	update(id: string, changes: Partial<ConsolidatedMemory>): Promise<void>;
	reinforce(id: string): Promise<void>;
	deactivate(id: string): Promise<void>;
	reactivate(id: string): Promise<void>;
	search(query: string, options?: ConsolidatedSearchOptions): Promise<ConsolidatedMemory[]>;
	getByCategory(category: MemoryCategory): Promise<ConsolidatedMemory[]>;
	getActive(minConfidence?: number): Promise<ConsolidatedMemory[]>;
}

interface ConsolidatedMemoryOptions {
	store: MemoryStore;
	embeddings: EmbeddingService;
	defaultTopK?: number;
}

interface ConsolidatedMemoryRow {
	id: string;
	created_at: string;
	updated_at: string;
	category: string;
	content: string;
	confidence: number;
	source_episodes: string | null;
	embedding: Uint8Array | null;
	active: number | boolean;
	reinforcement_count: number | null;
	last_reinforced_at: string | null;
	contradictions: string | null;
}

interface SearchQueryPlan {
	whereClause: string;
	params: Array<string | number>;
}

interface NextMemoryState {
	category: MemoryCategory;
	content: string;
	confidence: number;
	sourceEpisodes: string[];
	embedding: Float32Array | null;
	active: boolean;
	reinforcementCount: number;
	lastReinforcedAt: string | null;
	contradictions: string[];
}

const SELECT_MEMORIES = `SELECT id, created_at, updated_at, category, content, confidence, source_episodes, embedding, active,
		        reinforcement_count, last_reinforced_at, contradictions
		 FROM memories`;

function clampConfidence(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function parseJsonArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.map((item) => String(item));
	} catch {
		return [];
	}
}

function serializeEmbedding(embedding: Float32Array | null): Uint8Array | null {
	if (!embedding) return null;
	return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function deserializeEmbedding(value: Uint8Array | null): Float32Array | null {
	if (!value || value.byteLength < 4) return null;
	const bytes = new Uint8Array(value.byteLength);
	bytes.set(value);
	return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

function mapRowToMemory(row: ConsolidatedMemoryRow): ConsolidatedMemory {
	return {
		id: row.id,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
		category: row.category as MemoryCategory,
		content: row.content,
		confidence: row.confidence,
		sourceEpisodes: parseJsonArray(row.source_episodes),
		embedding: deserializeEmbedding(row.embedding),
		active: Boolean(row.active),
		reinforcementCount: row.reinforcement_count ?? 0,
		lastReinforcedAt: row.last_reinforced_at ? new Date(row.last_reinforced_at) : null,
		contradictions: parseJsonArray(row.contradictions),
	};
}

function lexicalScore(content: string, queryTokens: string[]): number {
	if (queryTokens.length === 0) return 0;
	const normalized = content.toLowerCase();
	let hits = 0;
	for (const token of queryTokens) {
		if (normalized.includes(token)) hits++;
	}
	return hits / queryTokens.length;
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

function tokenizeQuery(query: string): string[] {
	return query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}

function buildSearchQuery(options: ConsolidatedSearchOptions): SearchQueryPlan {
	const params: Array<string | number> = [];
	const filters: string[] = [];

	if (!options.includeInactive) {
		filters.push('active = 1');
	}
	if (options.minConfidence !== undefined) {
		filters.push('confidence >= ?');
		params.push(clampConfidence(options.minConfidence));
	}
	if (options.category) {
		filters.push('category = ?');
		params.push(options.category);
	}

	return {
		whereClause: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '',
		params,
	};
}

export function createConsolidatedMemoryStore(
	options: ConsolidatedMemoryOptions,
): ConsolidatedMemoryStore {
	const topKDefault = options.defaultTopK ?? 10;

	function getById(id: string): ConsolidatedMemory | null {
		const row = options.store.get<ConsolidatedMemoryRow>(
			`${SELECT_MEMORIES}
			 WHERE id = ?`,
			[id],
		);
		return row ? mapRowToMemory(row) : null;
	}

	function requireMemory(id: string): ConsolidatedMemory {
		const memory = getById(id);
		if (!memory) {
			throw new Error(`Memory not found: ${id}`);
		}
		return memory;
	}

	async function resolveEmbedding(content: string): Promise<Float32Array | null> {
		try {
			return await options.embeddings.embed(content);
		} catch (error) {
			logger.warn('Failed to generate consolidated embedding', {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async function resolveUpdatedEmbedding(
		current: ConsolidatedMemory,
		changes: Partial<ConsolidatedMemory>,
	): Promise<Float32Array | null> {
		if (!changes.content || changes.content === current.content) {
			return current.embedding;
		}
		return options.embeddings.embed(changes.content);
	}

	function buildNextState(
		current: ConsolidatedMemory,
		changes: Partial<ConsolidatedMemory>,
		embedding: Float32Array | null,
	): NextMemoryState {
		return {
			category: changes.category ?? current.category,
			content: changes.content ?? current.content,
			confidence: clampConfidence(changes.confidence ?? current.confidence),
			sourceEpisodes: changes.sourceEpisodes ?? current.sourceEpisodes,
			embedding,
			active: changes.active ?? current.active,
			reinforcementCount: changes.reinforcementCount ?? current.reinforcementCount,
			lastReinforcedAt: changes.lastReinforcedAt
				? changes.lastReinforcedAt.toISOString()
				: (current.lastReinforcedAt?.toISOString() ?? null),
			contradictions: changes.contradictions ?? current.contradictions,
		};
	}

	async function resolveQueryEmbedding(query: string): Promise<Float32Array | null> {
		try {
			return await options.embeddings.embed(query);
		} catch (error) {
			logger.warn('Failed to generate query embedding for consolidated search', {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	function rankSearchResults(
		memories: ConsolidatedMemory[],
		queryEmbedding: Float32Array | null,
		queryTokens: string[],
		topK: number,
	): ConsolidatedMemory[] {
		return memories
			.map((memory) => {
				const semantic = queryEmbedding ? cosineSimilarity(memory.embedding, queryEmbedding) : 0;
				const lexical = lexicalScore(memory.content, queryTokens);
				const confidenceBoost = memory.confidence * 0.05;
				const score = semantic * 0.75 + lexical * 0.25 + confidenceBoost;
				return { memory, score };
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map((item) => item.memory);
	}

	async function create(memory: NewConsolidatedMemory): Promise<string> {
		const id = uuidv4();
		const now = new Date().toISOString();
		const confidence = clampConfidence(memory.confidence ?? 1);
		const embedding = await resolveEmbedding(memory.content);

		options.store.run(
			`INSERT INTO memories (
				id, created_at, updated_at, category, content, confidence, source_episodes,
				embedding, active, reinforcement_count, last_reinforced_at, contradictions
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				now,
				now,
				memory.category,
				memory.content,
				confidence,
				JSON.stringify(memory.sourceEpisodes ?? []),
				serializeEmbedding(embedding),
				(memory.active ?? true) ? 1 : 0,
				1,
				now,
				JSON.stringify(memory.contradictions ?? []),
			],
		);

		return id;
	}

	async function update(id: string, changes: Partial<ConsolidatedMemory>): Promise<void> {
		const current = requireMemory(id);

		const now = new Date().toISOString();
		const nextEmbedding = await resolveUpdatedEmbedding(current, changes);
		const next = buildNextState(current, changes, nextEmbedding);

		options.store.run(
			`UPDATE memories
			 SET updated_at = ?,
			     category = ?,
			     content = ?,
			     confidence = ?,
			     source_episodes = ?,
			     embedding = ?,
			     active = ?,
			     reinforcement_count = ?,
			     last_reinforced_at = ?,
			     contradictions = ?
			 WHERE id = ?`,
			[
				now,
				next.category,
				next.content,
				next.confidence,
				JSON.stringify(next.sourceEpisodes),
				serializeEmbedding(next.embedding),
				next.active ? 1 : 0,
				next.reinforcementCount,
				next.lastReinforcedAt,
				JSON.stringify(next.contradictions),
				id,
			],
		);
	}

	async function reinforce(id: string): Promise<void> {
		requireMemory(id);

		const now = new Date().toISOString();
		options.store.run(
			`UPDATE memories
			 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1,
			     last_reinforced_at = ?,
			     updated_at = ?,
			     confidence = MIN(confidence + 0.05, 1.0)
			 WHERE id = ?`,
			[now, now, id],
		);
	}

	async function deactivate(id: string): Promise<void> {
		requireMemory(id);

		options.store.run(`UPDATE memories SET active = 0, updated_at = ? WHERE id = ?`, [
			new Date().toISOString(),
			id,
		]);
	}

	async function reactivate(id: string): Promise<void> {
		requireMemory(id);

		options.store.run(`UPDATE memories SET active = 1, updated_at = ? WHERE id = ?`, [
			new Date().toISOString(),
			id,
		]);
	}

	async function search(
		query: string,
		searchOptions: ConsolidatedSearchOptions = {},
	): Promise<ConsolidatedMemory[]> {
		const topK = searchOptions.topK ?? topKDefault;
		const queryTokens = tokenizeQuery(query);
		const sqlQuery = buildSearchQuery(searchOptions);
		const rows = options.store.all<ConsolidatedMemoryRow>(
			`${SELECT_MEMORIES}
			 ${sqlQuery.whereClause}
			 ORDER BY updated_at DESC
			 LIMIT 2000`,
			sqlQuery.params,
		);
		const memories = rows.map(mapRowToMemory);

		if (query.trim().length === 0) {
			return memories.slice(0, topK);
		}

		const queryEmbedding = await resolveQueryEmbedding(query);
		return rankSearchResults(memories, queryEmbedding, queryTokens, topK);
	}

	async function getByCategory(category: MemoryCategory): Promise<ConsolidatedMemory[]> {
		const rows = options.store.all<ConsolidatedMemoryRow>(
			`${SELECT_MEMORIES}
			 WHERE category = ? AND active = 1
			 ORDER BY confidence DESC, updated_at DESC`,
			[category],
		);
		return rows.map(mapRowToMemory);
	}

	async function getActive(minConfidence = 0): Promise<ConsolidatedMemory[]> {
		const rows = options.store.all<ConsolidatedMemoryRow>(
			`${SELECT_MEMORIES}
			 WHERE active = 1 AND confidence >= ?
			 ORDER BY confidence DESC, updated_at DESC`,
			[clampConfidence(minConfidence)],
		);
		return rows.map(mapRowToMemory);
	}

	return {
		create,
		update,
		reinforce,
		deactivate,
		reactivate,
		search,
		getByCategory,
		getActive,
	};
}
