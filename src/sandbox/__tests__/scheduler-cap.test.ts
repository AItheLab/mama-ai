import { describe, expect, it, vi } from 'vitest';
import { createSchedulerCapability } from '../scheduler-cap.js';

vi.mock('../../scheduler/registry.js', () => {
	return {
		getScheduler: () => ({
			listJobs: vi.fn(async () => [{ id: 'job-1', enabled: true }]),
			createJob: vi.fn(async () => 'job-2'),
			getJob: vi.fn(async (id: string) => ({ id, enabled: true })),
			enableJob: vi.fn(async () => undefined),
			disableJob: vi.fn(async () => undefined),
			deleteJob: vi.fn(async () => undefined),
		}),
	};
});

describe('scheduler-cap', () => {
	it('requires explicit approval token for create/manage', async () => {
		const cap = createSchedulerCapability();
		const create = await cap.execute('create_job', { schedule: 'every hour', task: 'do thing' });
		expect(create.success).toBe(false);
		expect(create.error).toContain('Missing explicit user approval token');

		const manage = await cap.execute('manage_job', { id: 'job-1', action: 'disable' });
		expect(manage.success).toBe(false);
		expect(manage.error).toContain('Missing explicit user approval token');
	});

	it('lists jobs without approval', async () => {
		const cap = createSchedulerCapability();
		const result = await cap.execute('list_jobs', {});
		expect(result.success).toBe(true);
		expect(Array.isArray(result.output)).toBe(true);
	});

	it('creates job with approval token', async () => {
		const cap = createSchedulerCapability();
		const result = await cap.execute('create_job', {
			name: 'test',
			schedule: 'every hour',
			task: 'task',
			__approvedByUser: true,
		});
		expect(result.success).toBe(true);
		const output = result.output as Record<string, unknown> | null;
		expect(output?.id).toBe('job-2');
	});
});
