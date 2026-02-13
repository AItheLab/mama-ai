import { z } from 'zod';
import { getScheduler } from '../../scheduler/registry.js';
import { createTool, type Tool } from './types.js';

const CreateScheduledJobParams = z.object({
	name: z.string().min(1).optional(),
	schedule: z.string().min(1),
	task: z.string().min(1),
});

const ListScheduledJobsParams = z.object({
	enabledOnly: z.boolean().optional(),
});

const ManageJobParams = z.object({
	id: z.string().min(1),
	action: z.enum(['enable', 'disable', 'delete']),
});

const createScheduledJobTool = createTool({
	name: 'create_scheduled_job',
	description: 'Create a persistent scheduled job for the agent.',
	parameters: CreateScheduledJobParams,
	jsonSchema: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Optional job name' },
			schedule: {
				type: 'string',
				description: 'Cron expression or natural language schedule (e.g. "every 30 minutes")',
			},
			task: { type: 'string', description: 'Task to execute on each run' },
		},
		required: ['schedule', 'task'],
	},
	async execute(params) {
		const scheduler = getScheduler();
		if (!scheduler) {
			return { success: false, output: null, error: 'Scheduler is not available.' };
		}

		const id = await scheduler.createJob(params);
		const created = await scheduler.getJob(id);
		return { success: true, output: created };
	},
});

const listScheduledJobsTool = createTool({
	name: 'list_scheduled_jobs',
	description: 'List all currently registered scheduled jobs.',
	parameters: ListScheduledJobsParams,
	jsonSchema: {
		type: 'object',
		properties: {
			enabledOnly: {
				type: 'boolean',
				description: 'When true, only enabled jobs are returned',
			},
		},
		required: [],
	},
	async execute(params) {
		const scheduler = getScheduler();
		if (!scheduler) {
			return { success: false, output: null, error: 'Scheduler is not available.' };
		}
		const jobs = await scheduler.listJobs();
		return {
			success: true,
			output: params.enabledOnly ? jobs.filter((job) => job.enabled) : jobs,
		};
	},
});

const manageJobTool = createTool({
	name: 'manage_job',
	description: 'Enable, disable, or delete an existing scheduled job.',
	parameters: ManageJobParams,
	jsonSchema: {
		type: 'object',
		properties: {
			id: { type: 'string', description: 'Job id' },
			action: {
				type: 'string',
				enum: ['enable', 'disable', 'delete'],
				description: 'Operation to apply',
			},
		},
		required: ['id', 'action'],
	},
	async execute(params) {
		const scheduler = getScheduler();
		if (!scheduler) {
			return { success: false, output: null, error: 'Scheduler is not available.' };
		}

		switch (params.action) {
			case 'enable':
				await scheduler.enableJob(params.id);
				break;
			case 'disable':
				await scheduler.disableJob(params.id);
				break;
			case 'delete':
				await scheduler.deleteJob(params.id);
				break;
		}

		return {
			success: true,
			output: {
				id: params.id,
				action: params.action,
			},
		};
	},
});

export function createSchedulerTools(): Tool[] {
	return [createScheduledJobTool, listScheduledJobsTool, manageJobTool];
}
