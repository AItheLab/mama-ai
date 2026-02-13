import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../memory/store.js';
import { createCronScheduler } from '../cron.js';

interface MockTask {
	id: string;
	expression: string;
	callback: () => void | Promise<void>;
	destroyed: boolean;
	stopped: boolean;
}

function createMockCronApi() {
	const tasks = new Map<string, MockTask>();
	let idCounter = 0;

	return {
		schedule(expression: string, callback: () => void | Promise<void>) {
			idCounter++;
			const task: MockTask = {
				id: `task-${idCounter}`,
				expression,
				callback,
				destroyed: false,
				stopped: false,
			};
			tasks.set(task.id, task);
			return {
				start() {
					task.stopped = false;
				},
				stop() {
					task.stopped = true;
				},
				destroy() {
					task.destroyed = true;
					tasks.delete(task.id);
				},
				getNextRun() {
					return new Date('2026-02-13T16:00:00.000Z');
				},
			};
		},
		validate(expression: string) {
			return /^(\S+\s){4}\S+$/.test(expression.trim());
		},
		async triggerAll() {
			for (const task of tasks.values()) {
				await task.callback();
			}
		},
		getActiveCount() {
			return tasks.size;
		},
		getExpressions() {
			return [...tasks.values()].map((task) => task.expression);
		},
	};
}

const tempRoots: string[] = [];

function createTempDbPath(): string {
	const root = mkdtempSync(join(tmpdir(), 'mama-cron-test-'));
	tempRoots.push(root);
	return join(root, 'mama.db');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe('createCronScheduler', () => {
	it('creates jobs, validates cron expressions, and persists them', async () => {
		const store = createMemoryStore({ dbPath: createTempDbPath() });
		const cronApi = createMockCronApi();
		const scheduler = await createCronScheduler({
			store,
			timezone: 'UTC',
			cronApi,
			runTask: vi.fn(async () => ({ success: true })),
		});

		const id = await scheduler.createJob({
			name: 'workspace-scan',
			schedule: '*/5 * * * *',
			task: 'List workspace files',
		});

		const job = await scheduler.getJob(id);
		expect(job).not.toBeNull();
		expect(job?.schedule).toBe('*/5 * * * *');
		expect(cronApi.getExpressions()).toContain('*/5 * * * *');

		store.close();
	});

	it('parses natural language schedules with LLM parser fallback', async () => {
		const store = createMemoryStore({ dbPath: createTempDbPath() });
		const cronApi = createMockCronApi();
		const scheduler = await createCronScheduler({
			store,
			timezone: 'UTC',
			cronApi,
			runTask: vi.fn(async () => ({ success: true })),
			parser: {
				parseNaturalLanguage: vi.fn(async () => '*/15 * * * *'),
			},
		});

		const id = await scheduler.createJob({
			schedule: 'every 15 minutes',
			task: 'Summarize notifications',
		});
		const job = await scheduler.getJob(id);
		expect(job?.schedule).toBe('*/15 * * * *');

		store.close();
	});

	it('executes jobs, stores results, and logs run counters', async () => {
		const store = createMemoryStore({ dbPath: createTempDbPath() });
		const cronApi = createMockCronApi();
		const runTask = vi.fn(async () => ({
			success: true,
			output: { message: 'ok' },
		}));
		const scheduler = await createCronScheduler({
			store,
			timezone: 'UTC',
			cronApi,
			runTask,
		});

		const id = await scheduler.createJob({
			schedule: '* * * * *',
			task: 'Do periodic work',
		});

		await cronApi.triggerAll();
		const job = await scheduler.getJob(id);
		expect(runTask).toHaveBeenCalledTimes(1);
		expect(job?.runCount).toBe(1);
		expect(job?.lastResult?.success).toBe(true);
		expect(job?.lastResult?.output).toEqual({ message: 'ok' });

		store.close();
	});

	it('loads enabled jobs on startup after restart', async () => {
		const dbPath = createTempDbPath();
		const cronApi1 = createMockCronApi();
		const store1 = createMemoryStore({ dbPath });
		const scheduler1 = await createCronScheduler({
			store: store1,
			timezone: 'UTC',
			cronApi: cronApi1,
			runTask: vi.fn(async () => ({ success: true })),
		});
		await scheduler1.createJob({
			name: 'persisted',
			schedule: '0 * * * *',
			task: 'Persist across restarts',
		});
		scheduler1.stop();
		store1.close();

		const cronApi2 = createMockCronApi();
		const store2 = createMemoryStore({ dbPath });
		const scheduler2 = await createCronScheduler({
			store: store2,
			timezone: 'UTC',
			cronApi: cronApi2,
			runTask: vi.fn(async () => ({ success: true })),
		});
		await scheduler2.start();

		const jobs = await scheduler2.listJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.name).toBe('persisted');
		expect(cronApi2.getActiveCount()).toBe(1);

		store2.close();
	});
});
