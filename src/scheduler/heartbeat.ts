import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type { AuditEntry } from '../sandbox/types.js';
import { createLogger } from '../utils/logger.js';
import type { JobRunResult } from './types.js';

const logger = createLogger('scheduler:heartbeat');

interface AuditStoreLike {
	log(entry: AuditEntry): void;
}

export interface HeartbeatRunReport {
	startedAt: string;
	finishedAt: string;
	checklistPath: string;
	checklistLength: number;
	systemState: {
		platform: string;
		uptimeSeconds: number;
		loadAverage: number[];
		freeMemoryBytes: number;
		totalMemoryBytes: number;
	};
	result: JobRunResult;
}

interface CreateHeartbeatOptions {
	intervalMinutes?: number;
	heartbeatFile: string;
	runTask: (prompt: string) => Promise<JobRunResult>;
	auditStore?: AuditStoreLike;
	onRun?: (report: HeartbeatRunReport) => void;
	readChecklist?: (path: string) => Promise<string>;
}

export interface HeartbeatController {
	start(): void;
	stop(): void;
	runOnce(): Promise<HeartbeatRunReport>;
	isRunning(): boolean;
}

function defaultReadChecklist(path: string): Promise<string> {
	return readFile(path, 'utf-8');
}

function collectSystemState() {
	const safeNumber = (fn: () => number, fallback = 0): number => {
		try {
			return fn();
		} catch {
			return fallback;
		}
	};
	const safeNumbers = (fn: () => number[], fallback: number[] = [0, 0, 0]): number[] => {
		try {
			return fn();
		} catch {
			return fallback;
		}
	};

	return {
		platform: process.platform,
		uptimeSeconds: Math.floor(safeNumber(() => os.uptime(), 0)),
		loadAverage: safeNumbers(() => os.loadavg()),
		freeMemoryBytes: safeNumber(() => os.freemem(), 0),
		totalMemoryBytes: safeNumber(() => os.totalmem(), 0),
	};
}

function buildHeartbeatPrompt(
	checklist: string,
	systemState: ReturnType<typeof collectSystemState>,
): string {
	return [
		'Review these heartbeat items and take action if needed.',
		'',
		'Checklist:',
		checklist.trim(),
		'',
		'Current system state:',
		JSON.stringify(systemState, null, 2),
	].join('\n');
}

export function createHeartbeat(options: CreateHeartbeatOptions): HeartbeatController {
	const intervalMs = Math.max(1, options.intervalMinutes ?? 30) * 60_000;
	const readChecklist = options.readChecklist ?? defaultReadChecklist;
	let timer: NodeJS.Timeout | null = null;
	let running = false;

	async function runOnce(): Promise<HeartbeatRunReport> {
		const startedAt = new Date();
		let checklist = '';
		try {
			checklist = await readChecklist(options.heartbeatFile);
		} catch {
			checklist =
				'# Heartbeat checklist missing\n- No checklist file found. Ask user to create one.';
		}

		const systemState = collectSystemState();
		const prompt = buildHeartbeatPrompt(checklist, systemState);
		let result: JobRunResult;
		try {
			result = await options.runTask(prompt);
		} catch (error) {
			result = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const finishedAt = new Date();
		const report: HeartbeatRunReport = {
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			checklistPath: options.heartbeatFile,
			checklistLength: checklist.length,
			systemState,
			result,
		};

		options.auditStore?.log({
			id: uuidv4(),
			timestamp: finishedAt,
			capability: 'heartbeat',
			action: 'run',
			resource: options.heartbeatFile,
			params: {
				checklistLength: checklist.length,
				systemState,
			},
			decision: 'auto-approved',
			result: result.success ? 'success' : 'error',
			output: JSON.stringify(result.output ?? null).slice(0, 1024),
			error: result.error,
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			requestedBy: 'heartbeat',
		});

		options.onRun?.(report);
		return report;
	}

	function start(): void {
		if (running) return;
		running = true;
		timer = setInterval(() => {
			runOnce().catch((error) => {
				logger.error('Heartbeat run failed', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, intervalMs);
	}

	function stop(): void {
		running = false;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	return {
		start,
		stop,
		runOnce,
		isRunning: () => running,
	};
}
