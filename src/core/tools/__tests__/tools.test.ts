import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool, getToolByName, getToolDefinitions } from '../index.js';
import type { ToolContext } from '../types.js';

function makeContext() {
	const sandbox = {
		execute: vi.fn(async (_capName: string, _action: string, _params: Record<string, unknown>) => ({
			success: true,
			output: { ok: true },
			durationMs: 1,
			auditEntry: {
				id: 'test-audit',
				timestamp: new Date(),
				capability: _capName,
				action: _action,
				resource: '',
				decision: 'auto-approved' as const,
				result: 'success' as const,
				durationMs: 1,
				requestedBy: 'tester',
			},
		})),
	};

	const context: ToolContext = {
		sandbox,
		requestedBy: 'tester',
	};

	return { sandbox, context };
}

describe('core tools', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('exports tool definitions in LLM-compatible format', () => {
		const definitions = getToolDefinitions();
		expect(definitions.length).toBeGreaterThan(0);
		expect(definitions.some((d) => d.name === 'read_file')).toBe(true);
		expect(definitions.some((d) => d.name === 'execute_command')).toBe(true);
		expect(definitions.some((d) => d.name === 'http_request')).toBe(true);
		expect(definitions.every((d) => typeof d.description === 'string')).toBe(true);
		expect(definitions.every((d) => typeof d.parameters === 'object')).toBe(true);
	});

	it('validates parameters before sandbox execution', async () => {
		const { sandbox, context } = makeContext();
		const writeTool = getToolByName('write_file');
		if (!writeTool) throw new Error('write_file tool not found');

		const result = await writeTool.run({ path: '' }, context);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Invalid tool parameters');
		expect(sandbox.execute).not.toHaveBeenCalled();
	});

	it('routes read_file through filesystem capability', async () => {
		const { sandbox, context } = makeContext();

		const result = await executeTool('read_file', { path: '/tmp/file.txt' }, context);

		expect(result.success).toBe(true);
		expect(sandbox.execute).toHaveBeenCalledWith(
			'filesystem',
			'read',
			{ path: '/tmp/file.txt' },
			'tester',
		);
	});

	it('routes execute_command through shell capability', async () => {
		const { sandbox, context } = makeContext();

		const result = await executeTool('execute_command', { command: 'echo hello' }, context);

		expect(result.success).toBe(true);
		expect(sandbox.execute).toHaveBeenCalledWith(
			'shell',
			'run',
			{
				command: 'echo hello',
				cwd: undefined,
				timeout: undefined,
			},
			'tester',
		);
	});

	it('routes http_request through network capability', async () => {
		const { sandbox, context } = makeContext();

		const result = await executeTool(
			'http_request',
			{ url: 'https://example.com', method: 'GET' },
			context,
		);

		expect(result.success).toBe(true);
		expect(sandbox.execute).toHaveBeenCalledWith(
			'network',
			'request',
			{
				url: 'https://example.com',
				method: 'GET',
				headers: undefined,
				body: undefined,
			},
			'tester',
		);
	});

	it('returns an error for unknown tools', async () => {
		const { context } = makeContext();
		const result = await executeTool('not_a_tool', {}, context);
		expect(result.success).toBe(false);
		expect(result.error).toContain('Unknown tool');
	});
});
