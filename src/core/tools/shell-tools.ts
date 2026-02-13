import { z } from 'zod';
import type { CapabilityResult } from '../../sandbox/types.js';
import { createTool, type Tool } from './types.js';

function fromCapabilityResult(result: CapabilityResult) {
	return {
		success: result.success,
		output: result.output,
		error: result.error,
	};
}

const ExecuteCommandParams = z.object({
	command: z.string().min(1),
	cwd: z.string().min(1).optional(),
	timeout: z.number().int().positive().max(300_000).optional(),
});

const executeCommandTool = createTool({
	name: 'execute_command',
	description: 'Execute a shell command through the sandbox policy engine.',
	parameters: ExecuteCommandParams,
	jsonSchema: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'Shell command to execute' },
			cwd: { type: 'string', description: 'Optional working directory' },
			timeout: { type: 'number', description: 'Optional timeout in milliseconds' },
		},
		required: ['command'],
	},
	async execute(params, context) {
		const result = await context.sandbox.execute(
			'shell',
			'run',
			{
				command: params.command,
				cwd: params.cwd,
				timeout: params.timeout,
			},
			context.requestedBy,
		);
		return fromCapabilityResult(result);
	},
});

export function createShellTools(): Tool[] {
	return [executeCommandTool];
}
