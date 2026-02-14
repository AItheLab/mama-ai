import { z } from 'zod';
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
	async execute(params, context) {
		const result = await context.sandbox.execute(
			'scheduler',
			'create_job',
			{ name: params.name, schedule: params.schedule, task: params.task },
			context.requestedBy,
		);
		return { success: result.success, output: result.output, error: result.error };
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
	async execute(params, context) {
		const result = await context.sandbox.execute('scheduler', 'list_jobs', {}, context.requestedBy);
		if (!result.success) {
			return { success: false, output: null, error: result.error };
		}
		const jobs = (result.output as unknown[] | null) ?? [];
		const enabledOnly = params.enabledOnly === true;
		if (!enabledOnly) {
			return { success: true, output: jobs };
		}

		const filtered = jobs.filter((job) => {
			if (job === null || typeof job !== 'object' || Array.isArray(job)) return false;
			const enabled = (job as Record<string, unknown>).enabled;
			return Boolean(enabled);
		});
		return { success: true, output: filtered };
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
	async execute(params, context) {
		const result = await context.sandbox.execute(
			'scheduler',
			'manage_job',
			{ id: params.id, action: params.action },
			context.requestedBy,
		);
		return { success: result.success, output: result.output, error: result.error };
	},
});

export function createSchedulerTools(): Tool[] {
	return [createScheduledJobTool, listScheduledJobsTool, manageJobTool];
}
