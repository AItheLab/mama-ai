import { createLogger } from '../utils/logger.js';
import type { ConsolidatedMemory, ConsolidatedMemoryStore } from './consolidated.js';
import type { Episode, EpisodicMemory } from './episodic.js';
import type { MemoryStore } from './store.js';
import { estimateTokens } from './working.js';

const logger = createLogger('memory:retrieval');

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
	'need',
	'want',
]);

interface RetrievalPipelineOptions {
	store: MemoryStore;
	episodic: EpisodicMemory;
	consolidated: ConsolidatedMemoryStore;
	maxMemoryResults?: number;
	maxRecentEpisodes?: number;
	recentWindowHours?: number;
	minConfidence?: number;
}

export interface RetrievedContext {
	entries: string[];
	formatted: string;
	tokenCount: number;
	stats: {
		tokenBudget: number;
		candidates: number;
		included: number;
		memories: number;
		episodes: number;
		goals: number;
	};
}

export interface MemoryRetrievalPipeline {
	retrieveContext(query: string, tokenBudget: number): Promise<RetrievedContext>;
}

interface JobRow {
	id: string;
	name: string;
	task: string;
	next_run: string | null;
}

type CandidateType = 'memory' | 'episode' | 'goal';

interface Candidate {
	type: CandidateType;
	score: number;
	entry: string;
	tokenCount: number;
}

function tokenizeQuery(query: string): string[] {
	return (
		query
			.toLowerCase()
			.match(/[a-z0-9]{3,}/g)
			?.filter((token) => !STOPWORDS.has(token))
			.slice(0, 10) ?? []
	);
}

function lexicalScore(value: string, queryTokens: string[]): number {
	if (queryTokens.length === 0) return 0;
	const normalized = value.toLowerCase();
	let hits = 0;
	for (const token of queryTokens) {
		if (normalized.includes(token)) hits += 1;
	}
	return hits / queryTokens.length;
}

function clampUnit(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function hoursSince(date: Date, now: Date): number {
	return Math.max(0, (now.getTime() - date.getTime()) / (1000 * 60 * 60));
}

function scoreMemory(memory: ConsolidatedMemory, queryTokens: string[], now: Date): number {
	const lexical = lexicalScore(memory.content, queryTokens);
	const freshness = clampUnit(1 - hoursSince(memory.updatedAt, now) / (24 * 14));
	return lexical * 0.5 + memory.confidence * 0.35 + freshness * 0.15;
}

function scoreEpisode(
	episode: Episode,
	queryTokens: string[],
	now: Date,
	windowHours: number,
): number {
	const lexical = lexicalScore(episode.content, queryTokens);
	const recency = clampUnit(1 - hoursSince(episode.timestamp, now) / windowHours);
	const importanceBoost = episode.metadata.importance === 'high' ? 0.15 : 0;
	return lexical * 0.55 + recency * 0.45 + importanceBoost;
}

function scoreGoal(job: JobRow, queryTokens: string[], now: Date): number {
	const lexical = lexicalScore(`${job.name} ${job.task}`, queryTokens);
	if (!job.next_run) {
		return lexical * 0.7 + 0.15;
	}
	const nextRun = new Date(job.next_run);
	const hoursUntil = (nextRun.getTime() - now.getTime()) / (1000 * 60 * 60);
	const urgency = hoursUntil <= 0 ? 1 : clampUnit(1 - hoursUntil / 24);
	return lexical * 0.6 + urgency * 0.4;
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

function formatMemoryEntry(memory: ConsolidatedMemory): string {
	return `[memory/${memory.category}/c=${memory.confidence.toFixed(2)}] ${truncate(memory.content, 220)}`;
}

function formatEpisodeEntry(episode: Episode): string {
	return `[recent/${episode.role}] ${truncate(episode.content, 180)}`;
}

function formatGoalEntry(job: JobRow): string {
	const nextRun = job.next_run ? ` (next: ${new Date(job.next_run).toISOString()})` : '';
	return `[goal/${job.name}] ${truncate(job.task, 160)}${nextRun}`;
}

function selectWithinBudget(
	candidates: Candidate[],
	tokenBudget: number,
): {
	entries: string[];
	tokenCount: number;
} {
	const entries: string[] = [];
	let usedTokens = 0;

	for (const candidate of candidates) {
		if (usedTokens + candidate.tokenCount > tokenBudget) {
			continue;
		}
		entries.push(candidate.entry);
		usedTokens += candidate.tokenCount;
	}

	return { entries, tokenCount: usedTokens };
}

export function createMemoryRetrievalPipeline(
	options: RetrievalPipelineOptions,
): MemoryRetrievalPipeline {
	const maxMemoryResults = options.maxMemoryResults ?? 10;
	const maxRecentEpisodes = options.maxRecentEpisodes ?? 20;
	const recentWindowHours = options.recentWindowHours ?? 24;
	const minConfidence = options.minConfidence ?? 0.3;

	function loadActiveJobs(limit = 20): JobRow[] {
		return options.store.all<JobRow>(
			`SELECT id, name, task, next_run
			 FROM jobs
			 WHERE enabled = 1
			 ORDER BY COALESCE(next_run, '9999-12-31T00:00:00.000Z') ASC
			 LIMIT ?`,
			[limit],
		);
	}

	async function retrieveContext(query: string, tokenBudget: number): Promise<RetrievedContext> {
		if (tokenBudget <= 0) {
			return {
				entries: [],
				formatted: '',
				tokenCount: 0,
				stats: {
					tokenBudget,
					candidates: 0,
					included: 0,
					memories: 0,
					episodes: 0,
					goals: 0,
				},
			};
		}

		const now = new Date();
		const queryTokens = tokenizeQuery(query);
		const [memories, recentEpisodes] = await Promise.all([
			options.consolidated.search(query, {
				topK: maxMemoryResults,
				minConfidence,
			}),
			options.episodic.getRecent(maxRecentEpisodes),
		]);

		const recentThreshold = now.getTime() - recentWindowHours * 60 * 60 * 1000;
		const episodes = recentEpisodes.filter(
			(episode) => episode.timestamp.getTime() >= recentThreshold,
		);
		const goals = loadActiveJobs();
		const candidates: Candidate[] = [];

		for (const memory of memories) {
			const entry = formatMemoryEntry(memory);
			candidates.push({
				type: 'memory',
				score: scoreMemory(memory, queryTokens, now),
				entry,
				tokenCount: estimateTokens(entry),
			});
		}

		for (const episode of episodes) {
			const entry = formatEpisodeEntry(episode);
			candidates.push({
				type: 'episode',
				score: scoreEpisode(episode, queryTokens, now, recentWindowHours),
				entry,
				tokenCount: estimateTokens(entry),
			});
		}

		for (const goal of goals) {
			const entry = formatGoalEntry(goal);
			candidates.push({
				type: 'goal',
				score: scoreGoal(goal, queryTokens, now),
				entry,
				tokenCount: estimateTokens(entry),
			});
		}

		candidates.sort((a, b) => b.score - a.score || a.tokenCount - b.tokenCount);
		const selected = selectWithinBudget(candidates, tokenBudget);
		const formatted = selected.entries.join('\n');

		logger.debug('Retrieved context from memory pipeline', {
			queryLength: query.length,
			tokenBudget,
			candidateCount: candidates.length,
			includedCount: selected.entries.length,
			selectedTokens: selected.tokenCount,
			memories: memories.length,
			episodes: episodes.length,
			goals: goals.length,
		});

		return {
			entries: selected.entries,
			formatted,
			tokenCount: selected.tokenCount,
			stats: {
				tokenBudget,
				candidates: candidates.length,
				included: selected.entries.length,
				memories: memories.length,
				episodes: episodes.length,
				goals: goals.length,
			},
		};
	}

	return {
		retrieveContext,
	};
}
