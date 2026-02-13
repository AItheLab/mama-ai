import { describe, expect, it, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '../../llm/types.js';
import { createSoul } from '../../memory/soul.js';
import { createWorkingMemory } from '../../memory/working.js';
import { createFsCapability } from '../../sandbox/fs-cap.js';
import { createSandbox } from '../../sandbox/sandbox.js';
import type { CapabilityResult } from '../../sandbox/types.js';
import { createAgent } from '../agent.js';
import type { SandboxExecutor } from '../tools/types.js';
import type { AgentEvent } from '../types.js';

function createMockRouter(responses: LLMResponse[]) {
	const complete = vi.fn<(req: LLMRequest) => Promise<LLMResponse>>();
	for (const response of responses) {
		complete.mockResolvedValueOnce(response);
	}
	if (responses.length > 0) {
		const last = responses[responses.length - 1];
		if (!last) throw new Error('Missing final response');
		complete.mockResolvedValue(last);
	}

	return {
		complete,
		route: vi.fn(),
		getCostTracker: vi.fn(),
	};
}

function createMockCapabilityResult(overrides: Partial<CapabilityResult> = {}): CapabilityResult {
	return {
		success: true,
		output: { ok: true },
		durationMs: 1,
		auditEntry: {
			id: 'audit-1',
			timestamp: new Date(),
			capability: 'filesystem',
			action: 'read',
			resource: '/tmp/file.txt',
			decision: 'auto-approved',
			result: 'success',
			durationMs: 1,
			requestedBy: 'terminal',
		},
		...overrides,
	};
}

function makeAgent(router: ReturnType<typeof createMockRouter>, sandbox?: SandboxExecutor) {
	return createAgent({
		router,
		workingMemory: createWorkingMemory({ maxTokens: 10000 }),
		soul: createSoul({
			soulPath: '/nonexistent',
			userName: 'Alex',
			agentName: 'Mama',
		}),
		sandbox,
	});
}

describe('Agent loop (Task 2.7)', () => {
	it('uses tools and continues until final response', async () => {
		const router = createMockRouter([
			{
				content: '',
				toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: '/tmp/notes.txt' } }],
				usage: { inputTokens: 40, outputTokens: 15 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'tool_use',
			},
			{
				content: 'Found notes in /tmp/notes.txt',
				toolCalls: [],
				usage: { inputTokens: 45, outputTokens: 20 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'end',
			},
		]);

		const sandbox = {
			execute: vi.fn(async () => createMockCapabilityResult({ output: { content: 'hello' } })),
		};

		const agent = makeAgent(router, sandbox);
		const response = await agent.processMessage('Read /tmp/notes.txt', 'terminal');

		expect(router.complete).toHaveBeenCalledTimes(2);
		expect(router.complete.mock.calls[0]?.[0].tools?.length).toBeGreaterThan(0);
		expect(sandbox.execute).toHaveBeenCalledWith(
			'filesystem',
			'read',
			{ path: '/tmp/notes.txt' },
			'terminal',
		);
		expect(response.content).toContain('Found notes');
		expect(response.toolCallsExecuted).toBe(1);
	});

	it('creates and executes multi-step plans', async () => {
		const router = createMockRouter([
			{
				content: JSON.stringify({
					goal: 'Create and list file',
					steps: [
						{
							id: 1,
							description: 'Create file',
							tool: 'write_file',
							params: { path: '/tmp/task27.txt', content: 'hello' },
							dependsOn: [],
							canFail: false,
						},
						{
							id: 2,
							description: 'List directory',
							tool: 'list_directory',
							params: { path: '/tmp' },
							dependsOn: [1],
							canFail: false,
						},
					],
					hasSideEffects: true,
					estimatedDuration: '~10s',
					risks: ['write may fail'],
				}),
				toolCalls: [],
				usage: { inputTokens: 120, outputTokens: 80 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'end',
			},
		]);

		const sandbox = {
			execute: vi.fn(async (_cap: string, action: string) =>
				createMockCapabilityResult({
					output: action === 'list' ? ['task27.txt'] : null,
				}),
			),
		};

		const agent = makeAgent(router, sandbox);
		const onPlanApproval = vi.fn(async () => true);
		const events: AgentEvent[] = [];

		const response = await agent.processMessage(
			'First create /tmp/task27.txt then list /tmp',
			'terminal',
			{
				onPlanApproval,
				onEvent: (event) => events.push(event),
			},
		);

		expect(onPlanApproval).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.type === 'plan_created')).toBe(true);
		expect(sandbox.execute).toHaveBeenCalledTimes(2);
		expect(response.content).toContain('Plan executed');
		expect(response.planExecution?.aborted).toBe(false);
	});

	it('aborts on failed critical steps', async () => {
		const router = createMockRouter([
			{
				content: JSON.stringify({
					goal: 'Run and then read',
					steps: [
						{
							id: 1,
							description: 'Run command',
							tool: 'execute_command',
							params: { command: 'false' },
							dependsOn: [],
							canFail: false,
						},
						{
							id: 2,
							description: 'Read file',
							tool: 'read_file',
							params: { path: '/tmp/never.txt' },
							dependsOn: [1],
							canFail: false,
						},
					],
					hasSideEffects: true,
					estimatedDuration: '~5s',
					risks: [],
				}),
				toolCalls: [],
				usage: { inputTokens: 90, outputTokens: 60 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'end',
			},
		]);

		const sandbox = {
			execute: vi.fn(async () =>
				createMockCapabilityResult({
					success: false,
					output: null,
					error: 'Command failed',
					auditEntry: {
						id: 'audit-fail',
						timestamp: new Date(),
						capability: 'shell',
						action: 'run',
						resource: 'false',
						decision: 'auto-approved',
						result: 'error',
						durationMs: 1,
						requestedBy: 'terminal',
					},
				}),
			),
		};

		const agent = makeAgent(router, sandbox);
		const response = await agent.processMessage('Run false then read file', 'terminal', {
			onPlanApproval: async () => true,
		});

		expect(sandbox.execute).toHaveBeenCalledTimes(2);
		expect(response.planExecution?.aborted).toBe(true);
		expect(response.content).toContain('Execution aborted');
	});

	it('stops after max tool iterations to avoid infinite loops', async () => {
		const toolUseResponse: LLMResponse = {
			content: '',
			toolCalls: [{ id: 'loop-1', name: 'read_file', arguments: { path: '/tmp/loop.txt' } }],
			usage: { inputTokens: 10, outputTokens: 5 },
			model: 'claude-sonnet-4-20250514',
			provider: 'claude',
			finishReason: 'tool_use',
		};
		const router = createMockRouter([toolUseResponse]);

		const sandbox = {
			execute: vi.fn(async () => createMockCapabilityResult()),
		};

		const agent = createAgent({
			router,
			workingMemory: createWorkingMemory({ maxTokens: 10000 }),
			soul: createSoul({
				soulPath: '/nonexistent',
				userName: 'Alex',
				agentName: 'Mama',
			}),
			sandbox: sandbox as never,
			maxIterations: 3,
		});

		const response = await agent.processMessage('Loop forever', 'terminal');

		expect(router.complete).toHaveBeenCalledTimes(3);
		expect(sandbox.execute).toHaveBeenCalledTimes(3);
		expect(response.content).toContain('Maximum tool iterations');
		expect(response.iterations).toBe(3);
	});

	it('respects approval flow for protected operations', async () => {
		const router = createMockRouter([
			{
				content: '',
				toolCalls: [
					{
						id: 'protected-1',
						name: 'write_file',
						arguments: { path: '/private/tmp/protected-task-27.txt', content: 'secret' },
					},
				],
				usage: { inputTokens: 35, outputTokens: 15 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'tool_use',
			},
			{
				content: 'I could not complete that write.',
				toolCalls: [],
				usage: { inputTokens: 40, outputTokens: 18 },
				model: 'claude-sonnet-4-20250514',
				provider: 'claude',
				finishReason: 'end',
			},
		]);

		const sandbox = createSandbox();
		sandbox.register(
			createFsCapability(
				{
					workspace: '/tmp/workspace-task-27',
					allowedPaths: [
						{
							path: '/private/tmp/protected-task-27.txt',
							actions: ['write'],
							level: 'ask',
						},
					],
					deniedPaths: [],
				},
				'/Users/alex',
			),
		);

		const approvalHandler = vi.fn(async () => false);
		sandbox.setApprovalHandler(approvalHandler);

		const agent = createAgent({
			router,
			workingMemory: createWorkingMemory({ maxTokens: 10000 }),
			soul: createSoul({
				soulPath: '/nonexistent',
				userName: 'Alex',
				agentName: 'Mama',
			}),
			sandbox,
		});

		await agent.processMessage('Write protected file', 'terminal');

		expect(approvalHandler).toHaveBeenCalledTimes(1);
		const toolMessage = agent.getConversationHistory().find((msg) => msg.role === 'tool');
		expect(toolMessage?.content).toContain('User denied the action');
	});
});
