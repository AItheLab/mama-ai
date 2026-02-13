import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { createLLMRouter } from '../llm/router.js';
import type { Message } from '../llm/types.js';
import { createLogger } from '../utils/logger.js';
import type { ConsolidatedMemoryStore, MemoryCategory } from './consolidated.js';
import type { DecayReport } from './decay.js';
import type { EmbeddingService } from './embeddings.js';
import type { Episode, EpisodicMemory } from './episodic.js';
import type { createSoul } from './soul.js';
import type { MemoryStore } from './store.js';

const logger = createLogger('memory:consolidation');

const CATEGORY_VALUES: [MemoryCategory, ...MemoryCategory[]] = [
	'fact',
	'preference',
	'pattern',
	'goal',
	'relationship',
	'skill',
	'routine',
	'emotional',
	'project',
];

const MemoryCategorySchema = z.enum(CATEGORY_VALUES);

const ConsolidationLLMResultSchema = z
	.object({
		new: z
			.array(
				z.object({
					category: MemoryCategorySchema,
					content: z.string().min(1),
					confidence: z.number().min(0).max(1).optional(),
					sourceEpisodes: z.array(z.string()).optional(),
				}),
			)
			.default([]),
		reinforce: z
			.array(
				z.object({
					memoryId: z.string().min(1),
					reason: z.string().optional(),
				}),
			)
			.default([]),
		update: z
			.array(
				z.object({
					memoryId: z.string().min(1),
					newContent: z.string().min(1),
					reason: z.string().optional(),
				}),
			)
			.default([]),
		contradict: z
			.array(
				z.object({
					memoryId: z.string().min(1),
					contradictedBy: z.string().min(1),
					resolution: z.string().optional(),
				}),
			)
			.default([]),
		decay: z
			.array(
				z.object({
					memoryId: z.string().min(1),
					newConfidence: z.number().min(0).max(1),
				}),
			)
			.default([]),
		connect: z
			.array(
				z.object({
					memoryA: z.string().min(1),
					memoryB: z.string().min(1),
					relationship: z.string().min(1),
				}),
			)
			.default([]),
	})
	.strict();

export type ConsolidationLLMResult = z.infer<typeof ConsolidationLLMResultSchema>;

export interface ConsolidationReport {
	startedAt: string;
	finishedAt: string;
	skipped: boolean;
	skipReason?: string;
	pendingEpisodes: number;
	processedEpisodes: number;
	created: number;
	reinforced: number;
	updated: number;
	contradicted: number;
	decayed: number;
	deactivated: number;
	connected: number;
	errors: string[];
	decayReport?: DecayReport;
}

export interface ConsolidationRunOptions {
	force?: boolean;
	minEpisodesToConsolidate?: number;
	runDecay?: boolean;
	regenerateSoul?: boolean;
}

interface ConsolidationEngineOptions {
	router: ReturnType<typeof createLLMRouter>;
	store: MemoryStore;
	episodic: EpisodicMemory;
	consolidated: ConsolidatedMemoryStore;
	embeddings: EmbeddingService;
	soul?: ReturnType<typeof createSoul>;
	decay?: { runDecay(): Promise<DecayReport> };
	batchSize?: number;
	minEpisodesToConsolidate?: number;
	deactivateThreshold?: number;
}

export interface ConsolidationEngine {
	runConsolidation(options?: ConsolidationRunOptions): Promise<ConsolidationReport>;
	getPendingEpisodeCount(): number;
}

interface ConsolidationSchedulerOptions {
	engine: ConsolidationEngine;
	intervalHours: number;
	minEpisodesToConsolidate: number;
	isIdle?: () => boolean;
	onReport?: (report: ConsolidationReport) => void;
}

interface ConsolidationScheduler {
	start(): void;
	stop(): void;
	runOnce(): Promise<ConsolidationReport>;
	isRunning(): boolean;
}

interface EpisodeRow {
	id: string;
	timestamp: string;
	channel: string;
	role: string;
	content: string;
	metadata: string | null;
	consolidated: number | boolean;
}

interface MemoryRow {
	id: string;
	category: MemoryCategory;
	content: string;
	confidence: number;
	source_episodes: string | null;
	reinforcement_count: number | null;
	last_reinforced_at: string | null;
	contradictions: string | null;
	active: number | boolean;
}

interface PreparedNewMemory {
	id: string;
	category: MemoryCategory;
	content: string;
	confidence: number;
	sourceEpisodes: string[];
	embedding: Float32Array | null;
}

interface PreparedUpdate {
	memoryId: string;
	newContent: string;
	embedding: Float32Array | null;
}

const EMPTY_RESULT: ConsolidationLLMResult = {
	new: [],
	reinforce: [],
	update: [],
	contradict: [],
	decay: [],
	connect: [],
};

type ReinforceAction = ConsolidationLLMResult['reinforce'][number];
type ContradictAction = ConsolidationLLMResult['contradict'][number];
type DecayAction = ConsolidationLLMResult['decay'][number];

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

function insertPreparedNewMemories(
	store: MemoryStore,
	items: PreparedNewMemory[],
	nowIso: string,
): void {
	for (const item of items) {
		store.run(
			`INSERT INTO memories (
				id, created_at, updated_at, category, content, confidence, source_episodes, embedding,
				active, reinforcement_count, last_reinforced_at, contradictions
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				item.id,
				nowIso,
				nowIso,
				item.category,
				item.content,
				item.confidence,
				JSON.stringify(item.sourceEpisodes),
				serializeEmbedding(item.embedding),
				1,
				1,
				nowIso,
				JSON.stringify([]),
			],
		);
	}
}

function applyReinforcements(store: MemoryStore, items: ReinforceAction[], nowIso: string): void {
	for (const item of items) {
		store.run(
			`UPDATE memories
			 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1,
			     confidence = MIN(confidence + 0.05, 1.0),
			     last_reinforced_at = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[nowIso, nowIso, item.memoryId],
		);
	}
}

function applyPreparedUpdates(store: MemoryStore, items: PreparedUpdate[], nowIso: string): void {
	for (const item of items) {
		store.run(
			`UPDATE memories
			 SET content = ?,
			     embedding = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[item.newContent, serializeEmbedding(item.embedding), nowIso, item.memoryId],
		);
	}
}

function applyContradictions(
	store: MemoryStore,
	items: ContradictAction[],
	nowIso: string,
	errors: string[],
): void {
	for (const item of items) {
		const row = store.get<MemoryRow>(
			`SELECT id, category, content, confidence, source_episodes, reinforcement_count,
			        last_reinforced_at, contradictions, active
			 FROM memories
			 WHERE id = ?`,
			[item.memoryId],
		);

		if (!row) {
			errors.push(`Missing memory for contradiction: ${item.memoryId}`);
			continue;
		}

		const contradictions = parseJsonArray(row.contradictions);
		if (!contradictions.includes(item.contradictedBy)) {
			contradictions.push(item.contradictedBy);
		}
		const loweredConfidence = Math.max(0.1, row.confidence - 0.2);

		store.run(
			`UPDATE memories
			 SET contradictions = ?, confidence = ?, updated_at = ?
			 WHERE id = ?`,
			[JSON.stringify(contradictions), loweredConfidence, nowIso, item.memoryId],
		);
	}
}

function applyDecayActions(
	store: MemoryStore,
	items: DecayAction[],
	nowIso: string,
	deactivateThreshold: number,
): number {
	let deactivated = 0;

	for (const item of items) {
		const confidence = clampConfidence(item.newConfidence);
		store.run(
			`UPDATE memories
			 SET confidence = ?, updated_at = ?
			 WHERE id = ?`,
			[confidence, nowIso, item.memoryId],
		);

		if (confidence < deactivateThreshold) {
			store.run(
				`UPDATE memories
				 SET active = 0, updated_at = ?
				 WHERE id = ?`,
				[nowIso, item.memoryId],
			);
			deactivated++;
		}
	}

	return deactivated;
}

function markEpisodesConsolidated(store: MemoryStore, episodes: Episode[]): void {
	if (episodes.length === 0) return;
	const placeholders = episodes.map(() => '?').join(', ');
	store.run(
		`UPDATE episodes
		 SET consolidated = 1
		 WHERE id IN (${placeholders})`,
		episodes.map((episode) => episode.id),
	);
}

function parseEpisodeRow(row: EpisodeRow): Episode {
	const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
	return {
		id: row.id,
		timestamp: new Date(row.timestamp),
		channel: row.channel,
		role: row.role,
		content: row.content,
		embedding: null,
		metadata,
		consolidated: Boolean(row.consolidated),
	};
}

function extractJsonBlock(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenced?.[1]) {
		return fenced[1].trim();
	}

	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return text.slice(firstBrace, lastBrace + 1).trim();
	}

	return null;
}

export function parseConsolidationResponse(text: string): ConsolidationLLMResult {
	const block = extractJsonBlock(text);
	if (!block) {
		return EMPTY_RESULT;
	}

	try {
		const raw = JSON.parse(block) as unknown;
		return ConsolidationLLMResultSchema.parse(raw);
	} catch {
		return EMPTY_RESULT;
	}
}

function promptMemoryView(memory: MemoryRow): Record<string, unknown> {
	return {
		id: memory.id,
		category: memory.category,
		content: memory.content,
		confidence: memory.confidence,
		sourceEpisodes: parseJsonArray(memory.source_episodes),
		reinforcementCount: memory.reinforcement_count ?? 0,
		lastReinforcedAt: memory.last_reinforced_at,
		contradictions: parseJsonArray(memory.contradictions),
	};
}

function promptEpisodeView(episode: Episode): Record<string, unknown> {
	return {
		id: episode.id,
		timestamp: episode.timestamp.toISOString(),
		channel: episode.channel,
		role: episode.role,
		content: episode.content,
		metadata: episode.metadata,
	};
}

export function buildConsolidationPrompt(params: {
	existingMemories: MemoryRow[];
	episodes: Episode[];
}): string {
	const existing = params.existingMemories.map(promptMemoryView);
	const episodes = params.episodes.map(promptEpisodeView);

	return [
		'You are the memory consolidation system for Mama.',
		'Analyze the new episodes and return strict JSON only.',
		'Prefer updating/reinforcing existing memories instead of duplicates.',
		'Categories allowed: fact, preference, pattern, goal, relationship, skill, routine, emotional, project.',
		'',
		'Output schema:',
		'{',
		'  "new": [{ "category": "...", "content": "...", "confidence": 0-1, "sourceEpisodes": ["..."] }],',
		'  "reinforce": [{ "memoryId": "...", "reason": "..." }],',
		'  "update": [{ "memoryId": "...", "newContent": "...", "reason": "..." }],',
		'  "contradict": [{ "memoryId": "...", "contradictedBy": "...", "resolution": "..." }],',
		'  "decay": [{ "memoryId": "...", "newConfidence": 0-1 }],',
		'  "connect": [{ "memoryA": "...", "memoryB": "...", "relationship": "..." }]',
		'}',
		'',
		`Current consolidated memories (${existing.length}):`,
		JSON.stringify(existing, null, 2),
		'',
		`New episodes (${episodes.length}):`,
		JSON.stringify(episodes, null, 2),
	].join('\n');
}

export function createConsolidationEngine(
	options: ConsolidationEngineOptions,
): ConsolidationEngine {
	const batchSize = options.batchSize ?? 100;
	const minEpisodesDefault = options.minEpisodesToConsolidate ?? 10;
	const deactivateThreshold = options.deactivateThreshold ?? 0.1;

	function getPendingEpisodeCount(): number {
		const row = options.store.get<{ count: number }>(
			'SELECT COUNT(*) AS count FROM episodes WHERE consolidated = 0',
		);
		return row?.count ?? 0;
	}

	function loadPendingEpisodes(limit: number): Episode[] {
		const rows = options.store.all<EpisodeRow>(
			`SELECT id, timestamp, channel, role, content, metadata, consolidated
			 FROM episodes
			 WHERE consolidated = 0
			 ORDER BY timestamp ASC
			 LIMIT ?`,
			[limit],
		);
		return rows.map(parseEpisodeRow);
	}

	function loadExistingMemories(): MemoryRow[] {
		return options.store.all<MemoryRow>(
			`SELECT id, category, content, confidence, source_episodes, reinforcement_count,
			        last_reinforced_at, contradictions, active
			 FROM memories
			 WHERE active = 1
			 ORDER BY confidence DESC, updated_at DESC
			 LIMIT 300`,
		);
	}

	async function embedOrNull(text: string): Promise<Float32Array | null> {
		try {
			return await options.embeddings.embed(text);
		} catch (error) {
			logger.warn('Failed to embed consolidation content', {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async function prepareNewMemories(
		items: ConsolidationLLMResult['new'],
	): Promise<PreparedNewMemory[]> {
		const prepared: PreparedNewMemory[] = [];
		for (const item of items) {
			prepared.push({
				id: uuidv4(),
				category: item.category,
				content: item.content,
				confidence: clampConfidence(item.confidence ?? 0.75),
				sourceEpisodes: item.sourceEpisodes ?? [],
				embedding: await embedOrNull(item.content),
			});
		}
		return prepared;
	}

	async function prepareUpdates(
		items: ConsolidationLLMResult['update'],
	): Promise<PreparedUpdate[]> {
		const prepared: PreparedUpdate[] = [];
		for (const item of items) {
			prepared.push({
				memoryId: item.memoryId,
				newContent: item.newContent,
				embedding: await embedOrNull(item.newContent),
			});
		}
		return prepared;
	}

	async function runConsolidation(
		runOptions: ConsolidationRunOptions = {},
	): Promise<ConsolidationReport> {
		const startedAt = new Date();
		const pendingCount = getPendingEpisodeCount();
		const threshold = runOptions.minEpisodesToConsolidate ?? minEpisodesDefault;
		if (!runOptions.force && pendingCount < threshold) {
			return {
				startedAt: startedAt.toISOString(),
				finishedAt: new Date().toISOString(),
				skipped: true,
				skipReason: `Only ${pendingCount} pending episodes (min ${threshold})`,
				pendingEpisodes: pendingCount,
				processedEpisodes: 0,
				created: 0,
				reinforced: 0,
				updated: 0,
				contradicted: 0,
				decayed: 0,
				deactivated: 0,
				connected: 0,
				errors: [],
			};
		}

		const episodes = loadPendingEpisodes(batchSize);
		if (episodes.length === 0) {
			return {
				startedAt: startedAt.toISOString(),
				finishedAt: new Date().toISOString(),
				skipped: true,
				skipReason: 'No unconsolidated episodes',
				pendingEpisodes: pendingCount,
				processedEpisodes: 0,
				created: 0,
				reinforced: 0,
				updated: 0,
				contradicted: 0,
				decayed: 0,
				deactivated: 0,
				connected: 0,
				errors: [],
			};
		}

		const existingMemories = loadExistingMemories();
		const prompt = buildConsolidationPrompt({ existingMemories, episodes });
		const request: Message = { role: 'user', content: prompt };
		const response = await options.router.complete({
			messages: [request],
			taskType: 'memory_consolidation',
			temperature: 0.1,
			maxTokens: 4096,
		});
		const parsed = parseConsolidationResponse(response.content);
		const preparedNew = await prepareNewMemories(parsed.new);
		const preparedUpdate = await prepareUpdates(parsed.update);
		const errors: string[] = [];
		let deactivated = 0;
		const nowIso = new Date().toISOString();

		options.store.transaction(() => {
			insertPreparedNewMemories(options.store, preparedNew, nowIso);
			applyReinforcements(options.store, parsed.reinforce, nowIso);
			applyPreparedUpdates(options.store, preparedUpdate, nowIso);
			applyContradictions(options.store, parsed.contradict, nowIso, errors);
			deactivated = applyDecayActions(options.store, parsed.decay, nowIso, deactivateThreshold);
			markEpisodesConsolidated(options.store, episodes);
		});

		let decayReport: DecayReport | undefined;
		if (runOptions.runDecay !== false && options.decay) {
			decayReport = await options.decay.runDecay();
		}

		if (runOptions.regenerateSoul !== false && options.soul) {
			const memories = await options.consolidated.getActive(0);
			options.soul.regenerateFromMemories(memories);
		}

		const report: ConsolidationReport = {
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			skipped: false,
			pendingEpisodes: pendingCount,
			processedEpisodes: episodes.length,
			created: preparedNew.length,
			reinforced: parsed.reinforce.length,
			updated: preparedUpdate.length,
			contradicted: parsed.contradict.length,
			decayed: parsed.decay.length,
			deactivated,
			connected: parsed.connect.length,
			errors,
			decayReport,
		};

		logger.info('Consolidation run finished', { ...report });
		return report;
	}

	return {
		runConsolidation,
		getPendingEpisodeCount,
	};
}

export function createConsolidationScheduler(
	options: ConsolidationSchedulerOptions,
): ConsolidationScheduler {
	const intervalMs = Math.max(60_000, options.intervalHours * 60 * 60 * 1000);
	let timer: NodeJS.Timeout | null = null;
	let running = false;

	async function tick(): Promise<ConsolidationReport> {
		if (running) {
			return {
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				skipped: true,
				skipReason: 'Consolidation already running',
				pendingEpisodes: options.engine.getPendingEpisodeCount(),
				processedEpisodes: 0,
				created: 0,
				reinforced: 0,
				updated: 0,
				contradicted: 0,
				decayed: 0,
				deactivated: 0,
				connected: 0,
				errors: [],
			};
		}

		if (options.isIdle && !options.isIdle()) {
			return {
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				skipped: true,
				skipReason: 'Agent is active',
				pendingEpisodes: options.engine.getPendingEpisodeCount(),
				processedEpisodes: 0,
				created: 0,
				reinforced: 0,
				updated: 0,
				contradicted: 0,
				decayed: 0,
				deactivated: 0,
				connected: 0,
				errors: [],
			};
		}

		running = true;
		try {
			const report = await options.engine.runConsolidation({
				minEpisodesToConsolidate: options.minEpisodesToConsolidate,
			});
			options.onReport?.(report);
			return report;
		} finally {
			running = false;
		}
	}

	function start(): void {
		if (timer) return;
		timer = setInterval(() => {
			void tick();
		}, intervalMs);
	}

	function stop(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	return {
		start,
		stop,
		runOnce: tick,
		isRunning: () => running,
	};
}
