import { z } from 'zod';
import type { CapabilityResult } from '../../sandbox/types.js';
import { createTool, type Tool, type ToolResult } from './types.js';

function fromCapabilityResult(result: CapabilityResult): ToolResult {
	return {
		success: result.success,
		output: result.output,
		error: result.error,
	};
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ReadFileParams = z.object({
	path: z.string().min(1),
});

const WriteFileParams = z.object({
	path: z.string().min(1),
	content: z.string(),
});

const ListDirectoryParams = z.object({
	path: z.string().min(1),
});

const SearchFilesParams = z.object({
	path: z.string().min(1),
	pattern: z.string().min(1),
});

const MoveFileParams = z.object({
	sourcePath: z.string().min(1),
	destinationPath: z.string().min(1),
});

const readFileTool = createTool({
	name: 'read_file',
	description: 'Read a UTF-8 text file from an allowed path.',
	parameters: ReadFileParams,
	jsonSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Absolute or relative file path to read' },
		},
		required: ['path'],
	},
	async execute(params, context) {
		const result = await context.sandbox.execute(
			'filesystem',
			'read',
			{ path: params.path },
			context.requestedBy,
		);
		return fromCapabilityResult(result);
	},
});

const writeFileTool = createTool({
	name: 'write_file',
	description: 'Create or overwrite a UTF-8 text file in an allowed path.',
	parameters: WriteFileParams,
	jsonSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path to write' },
			content: { type: 'string', description: 'Text content to write into the file' },
		},
		required: ['path', 'content'],
	},
	async execute(params, context) {
		const result = await context.sandbox.execute(
			'filesystem',
			'write',
			{ path: params.path, content: params.content },
			context.requestedBy,
		);
		return fromCapabilityResult(result);
	},
});

const listDirectoryTool = createTool({
	name: 'list_directory',
	description: 'List entries of an allowed directory path.',
	parameters: ListDirectoryParams,
	jsonSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Directory path to list' },
		},
		required: ['path'],
	},
	async execute(params, context) {
		const result = await context.sandbox.execute(
			'filesystem',
			'list',
			{ path: params.path },
			context.requestedBy,
		);
		return fromCapabilityResult(result);
	},
});

const searchFilesTool = createTool({
	name: 'search_files',
	description: 'Search files by name pattern under an allowed directory.',
	parameters: SearchFilesParams,
	jsonSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Directory root to search' },
			pattern: { type: 'string', description: 'find-compatible -name pattern (e.g. *.ts)' },
		},
		required: ['path', 'pattern'],
	},
	async execute(params, context) {
		const command = `find ${shQuote(params.path)} -name ${shQuote(params.pattern)} -print`;
		const result = await context.sandbox.execute('shell', 'run', { command }, context.requestedBy);

		if (!result.success) {
			return fromCapabilityResult(result);
		}

		const stdout = (result.output as { stdout?: string } | null)?.stdout ?? '';
		const files = stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return { success: true, output: files };
	},
});

const moveFileTool = createTool({
	name: 'move_file',
	description: 'Move or rename a file between allowed paths.',
	parameters: MoveFileParams,
	jsonSchema: {
		type: 'object',
		properties: {
			sourcePath: { type: 'string', description: 'Original file path' },
			destinationPath: { type: 'string', description: 'Destination file path' },
		},
		required: ['sourcePath', 'destinationPath'],
	},
	async execute(params, context) {
		const command = `mv -- ${shQuote(params.sourcePath)} ${shQuote(params.destinationPath)}`;
		const result = await context.sandbox.execute('shell', 'run', { command }, context.requestedBy);
		return fromCapabilityResult(result);
	},
});

export function createFsTools(): Tool[] {
	return [readFileTool, writeFileTool, listDirectoryTool, searchFilesTool, moveFileTool];
}
