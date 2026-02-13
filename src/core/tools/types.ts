import type { z } from 'zod';
import type { ToolDefinition } from '../../llm/types.js';
import type { CapabilityResult } from '../../sandbox/types.js';

export interface SandboxExecutor {
	execute(
		capName: string,
		action: string,
		params: Record<string, unknown>,
		requestedBy?: string,
	): Promise<CapabilityResult>;
}

export interface ToolContext {
	sandbox: SandboxExecutor;
	requestedBy?: string;
}

export interface ToolResult {
	success: boolean;
	output: unknown;
	error?: string;
}

export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
	name: string;
	description: string;
	parameters: TSchema;
	jsonSchema: Record<string, unknown>;
	execute(params: z.infer<TSchema>, context: ToolContext): Promise<ToolResult>;
	run(rawParams: unknown, context: ToolContext): Promise<ToolResult>;
	getDefinition(): ToolDefinition;
}

interface CreateToolArgs<TSchema extends z.ZodTypeAny> {
	name: string;
	description: string;
	parameters: TSchema;
	jsonSchema: Record<string, unknown>;
	execute(params: z.infer<TSchema>, context: ToolContext): Promise<ToolResult>;
}

function formatZodIssues(issues: z.ZodIssue[]): string {
	return issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
			return `${path}: ${issue.message}`;
		})
		.join('; ');
}

export function createTool<TSchema extends z.ZodTypeAny>(
	args: CreateToolArgs<TSchema>,
): Tool<TSchema> {
	return {
		name: args.name,
		description: args.description,
		parameters: args.parameters,
		jsonSchema: args.jsonSchema,
		execute: args.execute,
		async run(rawParams: unknown, context: ToolContext): Promise<ToolResult> {
			const parsed = args.parameters.safeParse(rawParams);
			if (!parsed.success) {
				return {
					success: false,
					output: null,
					error: `Invalid tool parameters: ${formatZodIssues(parsed.error.issues)}`,
				};
			}
			return args.execute(parsed.data, context);
		},
		getDefinition(): ToolDefinition {
			return {
				name: args.name,
				description: args.description,
				parameters: args.jsonSchema,
			};
		},
	};
}
