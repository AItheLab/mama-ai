import { createLogger } from '../utils/logger.js';
import type { ConsolidatedMemoryStore } from './consolidated.js';
import type { MemoryStore } from './store.js';

const logger = createLogger('memory:decay');

export interface DecayReport {
	checked: number;
	decayed: number;
	deactivated: number;
}

export interface DecayOptions {
	store: MemoryStore;
	consolidated: ConsolidatedMemoryStore;
	inactiveDaysThreshold?: number;
	decayFactor?: number;
	deactivateThreshold?: number;
	now?: Date;
}

interface DecayCandidate {
	id: string;
	created_at: string;
	last_reinforced_at: string | null;
	confidence: number;
}

function clampConfidence(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function daysBetween(older: Date, newer: Date): number {
	return Math.max(0, (newer.getTime() - older.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Creates a decay runner for consolidated memories.
 */
export function createDecayEngine(options: DecayOptions) {
	const inactiveDaysThreshold = options.inactiveDaysThreshold ?? 30;
	const decayFactor = options.decayFactor ?? 0.9;
	const deactivateThreshold = options.deactivateThreshold ?? 0.1;

	async function runDecay(): Promise<DecayReport> {
		const now = options.now ?? new Date();
		const candidates = options.store.all<DecayCandidate>(
			`SELECT id, created_at, last_reinforced_at, confidence
			 FROM memories
			 WHERE active = 1`,
		);

		let decayed = 0;
		let deactivated = 0;

		for (const candidate of candidates) {
			const reference = candidate.last_reinforced_at
				? new Date(candidate.last_reinforced_at)
				: new Date(candidate.created_at);
			const ageDays = daysBetween(reference, now);

			if (ageDays < inactiveDaysThreshold) {
				continue;
			}

			const newConfidence = clampConfidence(candidate.confidence * decayFactor);
			if (newConfidence !== candidate.confidence) {
				await options.consolidated.update(candidate.id, { confidence: newConfidence });
				decayed++;
			}

			if (newConfidence < deactivateThreshold) {
				await options.consolidated.deactivate(candidate.id);
				deactivated++;
			}
		}

		logger.info('Decay run completed', {
			checked: candidates.length,
			decayed,
			deactivated,
		});

		return {
			checked: candidates.length,
			decayed,
			deactivated,
		};
	}

	return {
		runDecay,
	};
}
