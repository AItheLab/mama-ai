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

const HttpRequestParams = z.object({
	url: z.string().url(),
	method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
	headers: z.record(z.string()).optional(),
	body: z.string().optional(),
});

const httpRequestTool = createTool({
	name: 'http_request',
	description: 'Execute an outbound HTTP request through sandboxed network rules.',
	parameters: HttpRequestParams,
	jsonSchema: {
		type: 'object',
		properties: {
			url: { type: 'string', description: 'Fully-qualified URL to request' },
			method: {
				type: 'string',
				enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
				description: 'HTTP method',
			},
			headers: {
				type: 'object',
				additionalProperties: { type: 'string' },
				description: 'Optional request headers',
			},
			body: { type: 'string', description: 'Optional request body for non-GET methods' },
		},
		required: ['url'],
	},
	async execute(params, context) {
		const result = await context.sandbox.execute(
			'network',
			'request',
			{
				url: params.url,
				method: params.method,
				headers: params.headers,
				body: params.body,
			},
			context.requestedBy,
		);
		return fromCapabilityResult(result);
	},
});

export function createNetworkTools(): Tool[] {
	return [httpRequestTool];
}
