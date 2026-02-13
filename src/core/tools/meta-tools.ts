import { z } from 'zod';
import { createTool, type Tool } from './types.js';

const AskUserParams = z.object({
	question: z.string().min(1),
	context: z.string().optional(),
});

const ReportProgressParams = z.object({
	message: z.string().min(1),
	percent: z.number().min(0).max(100).optional(),
});

const askUserTool = createTool({
	name: 'ask_user',
	description: 'Request clarification from the user when task intent is ambiguous.',
	parameters: AskUserParams,
	jsonSchema: {
		type: 'object',
		properties: {
			question: { type: 'string', description: 'Question to ask the user' },
			context: { type: 'string', description: 'Optional context shown with the question' },
		},
		required: ['question'],
	},
	async execute(params) {
		return {
			success: true,
			output: {
				type: 'user-question',
				requiresUserInput: true,
				question: params.question,
				context: params.context,
			},
		};
	},
});

const reportProgressTool = createTool({
	name: 'report_progress',
	description: 'Emit structured progress updates during multi-step execution.',
	parameters: ReportProgressParams,
	jsonSchema: {
		type: 'object',
		properties: {
			message: { type: 'string', description: 'Progress message' },
			percent: { type: 'number', description: 'Optional completion percentage (0-100)' },
		},
		required: ['message'],
	},
	async execute(params) {
		return {
			success: true,
			output: {
				type: 'progress-update',
				message: params.message,
				percent: params.percent,
			},
		};
	},
});

export function createMetaTools(): Tool[] {
	return [askUserTool, reportProgressTool];
}
