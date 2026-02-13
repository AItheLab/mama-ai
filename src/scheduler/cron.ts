import { v4 as uuidv4 } from 'uuid';
import type { MemoryStore } from '../memory/store.js';
import type { AuditEntry } from '../sandbox/types.js';
import { createLogger } from '../utils/logger.js';
import type {
	Job,
	JobLastResult,
	JobRunContext,
	JobRunResult,
	NewJob,
	ScheduleParser,
} from './types.js';

const logger = createLogger('scheduler:cron');

interface AuditStoreLike {
	log(entry: AuditEntry): void;
}

interface ScheduledTaskLike {
	start(): void;
	stop(): void;
	destroy(): void;
	getNextRun?(): Date | null;
}

interface CronApi {
	schedule(
		expression: string,
		callback: () => void | Promise<void>,
		options?: { timezone?: string },
	): ScheduledTaskLike;
	validate(expression: string): boolean;
}

interface JobRow {
	id: string;
	name: string;
	type: string;
	schedule: string | null;
	task: string;
	enabled: number | boolean;
	last_run: string | null;
	next_run: string | null;
	run_count: number | null;
	last_result: string | null;
}

interface CreateCronSchedulerOptions {
	store: MemoryStore;
	timezone: string;
	runTask: (task: string, context: JobRunContext) => Promise<JobRunResult>;
	parser?: ScheduleParser;
	auditStore?: AuditStoreLike;
	cronApi?: CronApi;
}

interface CronScheduler {
	start(): Promise<void>;
	stop(): void;
	createJob(job: NewJob): Promise<string>;
	listJobs(): Promise<Job[]>;
	getJob(id: string): Promise<Job | null>;
	enableJob(id: string): Promise<void>;
	disableJob(id: string): Promise<void>;
	deleteJob(id: string): Promise<void>;
	runJobNow(id: string): Promise<JobRunResult>;
	parseSchedule(schedule: string): Promise<string>;
}

type CronModule = typeof import('node-cron');

let cachedCronApi: CronApi | null = null;

async function loadDefaultCronApi(): Promise<CronApi> {
	if (cachedCronApi) return cachedCronApi;
	const module = (await import('node-cron')) as CronModule;
	cachedCronApi = {
		schedule: module.schedule,
		validate: module.validate,
	};
	return cachedCronApi;
}

function parseTimestamp(value: string | null): Date | null {
	return value ? new Date(value) : null;
}

function parseLastResult(value: string | null): JobLastResult | null {
	if (!value) return null;
	try {
		return JSON.parse(value) as JobLastResult;
	} catch {
		return null;
	}
}

function mapJobRow(row: JobRow): Job {
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		schedule: row.schedule ?? '',
		task: row.task,
		enabled: Boolean(row.enabled),
		lastRun: parseTimestamp(row.last_run),
		nextRun: parseTimestamp(row.next_run),
		runCount: row.run_count ?? 0,
		lastResult: parseLastResult(row.last_result),
	};
}

function fallbackNaturalScheduleToCron(schedule: string): string | null {
	const normalized = schedule.trim().toLowerCase();
	if (normalized === 'every minute') return '* * * * *';
	if (normalized === 'every hour' || normalized === 'hourly') return '0 * * * *';
	if (normalized === 'every day' || normalized === 'daily') return '0 9 * * *';
	if (normalized === 'every week' || normalized === 'weekly') return '0 9 * * 1';
	if (normalized === 'every month' || normalized === 'monthly') return '0 9 1 * *';

	const everyMinutes = normalized.match(/^every\s+(\d+)\s+minutes?$/);
	if (everyMinutes?.[1]) {
		const value = Number.parseInt(everyMinutes[1], 10);
		if (value >= 1 && value <= 59) return `*/${value} * * * *`;
	}

	const everyHours = normalized.match(/^every\s+(\d+)\s+hours?$/);
	if (everyHours?.[1]) {
		const value = Number.parseInt(everyHours[1], 10);
		if (value >= 1 && value <= 23) return `0 */${value} * * *`;
	}

	const dailyAt = normalized.match(/^every day at (\d{1,2}):(\d{2})$/);
	if (dailyAt?.[1] && dailyAt[2]) {
		const hour = Number.parseInt(dailyAt[1], 10);
		const minute = Number.parseInt(dailyAt[2], 10);
		if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
			return `${minute} ${hour} * * *`;
		}
	}

	const weeklyAt = normalized.match(
		/^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d{1,2}):(\d{2})$/,
	);
	if (weeklyAt?.[1] && weeklyAt[2] && weeklyAt[3]) {
		const dayMap: Record<string, number> = {
			sunday: 0,
			monday: 1,
			tuesday: 2,
			wednesday: 3,
			thursday: 4,
			friday: 5,
			saturday: 6,
		};
		const day = dayMap[weeklyAt[1]];
		const hour = Number.parseInt(weeklyAt[2], 10);
		const minute = Number.parseInt(weeklyAt[3], 10);
		if (day !== undefined && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
			return `${minute} ${hour} * * ${day}`;
		}
	}

	return null;
}

function nextRunFromTask(task: ScheduledTaskLike): Date | null {
	const next = task.getNextRun?.();
	if (!next) return null;
	return Number.isNaN(next.getTime()) ? null : next;
}

export async function createCronScheduler(
	options: CreateCronSchedulerOptions,
): Promise<CronScheduler> {
	const cronApi = options.cronApi ?? (await loadDefaultCronApi());
	const activeTasks = new Map<string, ScheduledTaskLike>();

	async function parseSchedule(schedule: string): Promise<string> {
		const trimmed = schedule.trim();
		if (trimmed.length === 0) {
			throw new Error('Schedule cannot be empty');
		}

		if (cronApi.validate(trimmed)) {
			return trimmed;
		}

		let parsedByLlm: string | null = null;
		if (options.parser) {
			parsedByLlm = await options.parser.parseNaturalLanguage(trimmed);
			if (parsedByLlm && cronApi.validate(parsedByLlm)) {
				return parsedByLlm;
			}
		}

		const fallback = fallbackNaturalScheduleToCron(trimmed);
		if (fallback && cronApi.validate(fallback)) {
			return fallback;
		}

		throw new Error(
			`Invalid schedule "${schedule}". Use a cron expression or natural format like "every 30 minutes".`,
		);
	}

	function readJobRow(id: string): JobRow | null {
		const row = options.store.get<JobRow>(
			`SELECT id, name, type, schedule, task, enabled, last_run, next_run, run_count, last_result
			 FROM jobs
			 WHERE id = ?`,
			[id],
		);
		return row ?? null;
	}

	function registerJob(row: JobRow): void {
		if (!row.schedule || !row.enabled) return;
		if (activeTasks.has(row.id)) return;

		const task = cronApi.schedule(
			row.schedule,
			async () => {
				try {
					await runJobNow(row.id);
				} catch (error) {
					logger.error('Scheduled job execution failed', {
						id: row.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			},
			{ timezone: options.timezone },
		);
		activeTasks.set(row.id, task);

		const nextRun = nextRunFromTask(task)?.toISOString() ?? null;
		options.store.run('UPDATE jobs SET next_run = ? WHERE id = ?', [nextRun, row.id]);
	}

	function unregisterJob(id: string): void {
		const task = activeTasks.get(id);
		if (!task) return;
		task.stop();
		task.destroy();
		activeTasks.delete(id);
	}

	async function listJobs(): Promise<Job[]> {
		const rows = options.store.all<JobRow>(
			`SELECT id, name, type, schedule, task, enabled, last_run, next_run, run_count, last_result
			 FROM jobs
			 ORDER BY name ASC`,
		);
		return rows.map(mapJobRow);
	}

	async function getJob(id: string): Promise<Job | null> {
		const row = readJobRow(id);
		return row ? mapJobRow(row) : null;
	}

	async function runJobNow(id: string): Promise<JobRunResult> {
		const row = readJobRow(id);
		if (!row) {
			throw new Error(`Job not found: ${id}`);
		}

		const job = mapJobRow(row);
		const startedAt = Date.now();
		const nowIso = new Date().toISOString();

		let result: JobRunResult;
		try {
			result = await options.runTask(job.task, {
				jobId: job.id,
				jobName: job.name,
				task: job.task,
			});
		} catch (error) {
			result = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const task = activeTasks.get(job.id);
		const nextRunIso = task ? (nextRunFromTask(task)?.toISOString() ?? null) : null;
		const finishedAt = new Date().toISOString();
		const lastResult: JobLastResult = {
			success: result.success,
			output: result.output,
			error: result.error,
			finishedAt,
		};

		options.store.run(
			`UPDATE jobs
			 SET last_run = ?, next_run = ?, run_count = COALESCE(run_count, 0) + 1, last_result = ?
			 WHERE id = ?`,
			[nowIso, nextRunIso, JSON.stringify(lastResult), job.id],
		);

		options.auditStore?.log({
			id: uuidv4(),
			timestamp: new Date(),
			capability: 'scheduler',
			action: 'run_job',
			resource: job.id,
			params: {
				jobId: job.id,
				jobName: job.name,
				task: job.task,
			},
			decision: 'auto-approved',
			result: result.success ? 'success' : 'error',
			output: JSON.stringify(result.output ?? null).slice(0, 1024),
			error: result.error,
			durationMs: Date.now() - startedAt,
			requestedBy: 'scheduler',
		});

		return result;
	}

	async function createJob(job: NewJob): Promise<string> {
		if (job.task.trim().length === 0) {
			throw new Error('Task cannot be empty');
		}
		const id = uuidv4();
		const schedule = await parseSchedule(job.schedule);
		const name = job.name?.trim() ? job.name.trim() : `job-${id.slice(0, 8)}`;
		const type = job.type?.trim() ? job.type.trim() : 'cron';

		options.store.run(
			`INSERT INTO jobs (id, name, type, schedule, task, enabled, run_count)
			 VALUES (?, ?, ?, ?, ?, 1, 0)`,
			[id, name, type, schedule, job.task],
		);

		const row = readJobRow(id);
		if (row) registerJob(row);

		logger.info('Scheduled job created', { id, name, schedule });
		return id;
	}

	async function enableJob(id: string): Promise<void> {
		const row = readJobRow(id);
		if (!row) throw new Error(`Job not found: ${id}`);
		options.store.run('UPDATE jobs SET enabled = 1 WHERE id = ?', [id]);
		registerJob({ ...row, enabled: 1 });
	}

	async function disableJob(id: string): Promise<void> {
		const row = readJobRow(id);
		if (!row) throw new Error(`Job not found: ${id}`);
		options.store.run('UPDATE jobs SET enabled = 0, next_run = NULL WHERE id = ?', [id]);
		unregisterJob(id);
	}

	async function deleteJob(id: string): Promise<void> {
		unregisterJob(id);
		options.store.run('DELETE FROM jobs WHERE id = ?', [id]);
	}

	async function start(): Promise<void> {
		const rows = options.store.all<JobRow>(
			`SELECT id, name, type, schedule, task, enabled, last_run, next_run, run_count, last_result
			 FROM jobs
			 WHERE enabled = 1`,
		);
		for (const row of rows) {
			registerJob(row);
		}
	}

	function stop(): void {
		for (const task of activeTasks.values()) {
			task.stop();
			task.destroy();
		}
		activeTasks.clear();
	}

	return {
		start,
		stop,
		createJob,
		listJobs,
		getJob,
		enableJob,
		disableJob,
		deleteJob,
		runJobNow,
		parseSchedule,
	};
}

export type { CronScheduler, CreateCronSchedulerOptions };
