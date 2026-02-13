import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/core/agent.js';
import type { LLMRequest, LLMResponse } from '../src/llm/types.js';
import { createSoul } from '../src/memory/soul.js';
import { createWorkingMemory } from '../src/memory/working.js';
import { createFsCapability } from '../src/sandbox/fs-cap.js';
import { createNetworkCapability } from '../src/sandbox/network-cap.js';
import { createSandbox } from '../src/sandbox/sandbox.js';
import { createShellCapability } from '../src/sandbox/shell-cap.js';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'mama-phase2-'));

function createSequentialRouter(responses: LLMResponse[]) {
	let index = 0;

	return {
		complete: vi.fn<(req: LLMRequest) => Promise<LLMResponse>>().mockImplementation(async () => {
			const response = responses[Math.min(index, responses.length - 1)];
			index++;
			if (!response) {
				throw new Error('No mocked LLM response available');
			}
			return response;
		}),
		route: vi.fn(),
		getCostTracker: vi.fn(() => ({
			getRecords: () => [],
			getTotalCost: () => 0,
		})),
	};
}

function createScenarioDirs(id: string): {
	root: string;
	homeDir: string;
	workspaceDir: string;
	repoDir: string;
} {
	const root = join(fixtureRoot, id);
	const homeDir = join(root, 'home');
	const workspaceDir = join(root, 'workspace');
	const repoDir = join(homeDir, 'Projects', 'mama');

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(repoDir, { recursive: true });

	return {
		root: realpathSync(root),
		homeDir: realpathSync(homeDir),
		workspaceDir: realpathSync(workspaceDir),
		repoDir: realpathSync(repoDir),
	};
}

function createTestSandbox(homeDir: string, workspaceDir: string, approvals = true) {
	const sandbox = createSandbox();
	sandbox.register(
		createFsCapability(
			{
				workspace: workspaceDir,
				allowedPaths: [],
				deniedPaths: [`${homeDir}/.ssh/**`],
			},
			homeDir,
		),
	);
	sandbox.register(
		createShellCapability({
			safeCommands: [
				'ls',
				'cat',
				'head',
				'tail',
				'grep',
				'find',
				'wc',
				'date',
				'whoami',
				'pwd',
				'echo',
				'git status',
				'git log',
				'git diff',
			],
			askCommands: ['git commit', 'git push', 'git pull', 'mkdir', 'cp', 'mv', 'npm', 'pnpm', 'node'],
			deniedPatterns: ['rm -rf', 'sudo', 'curl | bash', 'wget | sh', 'chmod 777', '> /dev', 'mkfs', 'dd if='],
		}),
	);
	sandbox.register(
		createNetworkCapability({
			allowedDomains: ['localhost'],
			askDomains: true,
			rateLimitPerMinute: 30,
			logAllRequests: false,
		}),
	);
	sandbox.setApprovalHandler(async () => approvals);
	return sandbox;
}

function createTestAgent(responses: LLMResponse[], sandbox: ReturnType<typeof createSandbox>) {
	const router = createSequentialRouter(responses);
	return createAgent({
		router,
		workingMemory: createWorkingMemory({ maxTokens: 100000 }),
		soul: createSoul({
			soulPath: '/nonexistent',
			userName: 'Alex',
			agentName: 'Mama',
		}),
		sandbox,
		maxIterations: 10,
	});
}

function parseLastToolResult(agent: ReturnType<typeof createAgent>): {
	success: boolean;
	output: unknown;
	error?: string;
} {
	const toolMessage = [...agent.getConversationHistory()].reverse().find((msg) => msg.role === 'tool');
	if (!toolMessage) {
		throw new Error('Expected at least one tool message');
	}
	return JSON.parse(toolMessage.content) as { success: boolean; output: unknown; error?: string };
}

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Phase 2.8 integration scenarios', () => {
	it('1) "List the files in my workspace" uses list_directory and auto-approves', async () => {
		const { homeDir, workspaceDir } = createScenarioDirs('case-1-list-workspace');
		writeFileSync(join(workspaceDir, 'a.txt'), 'A', 'utf-8');
		writeFileSync(join(workspaceDir, 'b.md'), 'B', 'utf-8');

		const sandbox = createTestSandbox(homeDir, workspaceDir, true);
		const agent = createTestAgent(
			[
				{
					content: '',
					toolCalls: [{ id: 'tc-1', name: 'list_directory', arguments: { path: workspaceDir } }],
					usage: { inputTokens: 40, outputTokens: 12 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'tool_use',
				},
				{
					content: 'Listed workspace files.',
					toolCalls: [],
					usage: { inputTokens: 45, outputTokens: 15 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				},
			],
			sandbox,
		);

		const response = await agent.processMessage('List the files in my workspace', 'terminal');
		const toolResult = parseLastToolResult(agent);

		expect(response.content).toContain('Listed workspace files');
		expect(toolResult.success).toBe(true);
		expect(toolResult.output).toEqual(expect.arrayContaining(['a.txt', 'b.md']));
	});

	it('2) "Create a file called test.md with content Hello" writes in workspace (auto-approved)', async () => {
		const { homeDir, workspaceDir } = createScenarioDirs('case-2-create-file');
		const outputPath = join(workspaceDir, 'test.md');

		const sandbox = createTestSandbox(homeDir, workspaceDir, true);
		const agent = createTestAgent(
			[
				{
					content: '',
					toolCalls: [
						{
							id: 'tc-2',
							name: 'write_file',
							arguments: { path: outputPath, content: 'Hello' },
						},
					],
					usage: { inputTokens: 35, outputTokens: 12 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'tool_use',
				},
				{
					content: 'File created.',
					toolCalls: [],
					usage: { inputTokens: 40, outputTokens: 14 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				},
			],
			sandbox,
		);

		await agent.processMessage("Create a file called test.md with content 'Hello'", 'terminal');
		const toolResult = parseLastToolResult(agent);

		expect(toolResult.success).toBe(true);
		expect(existsSync(outputPath)).toBe(true);
		expect(readFileSync(outputPath, 'utf-8')).toBe('Hello');
	});

	it('3) "Read my SSH key" is denied by sandbox', async () => {
		const { homeDir, workspaceDir } = createScenarioDirs('case-3-read-ssh-denied');
		const sshKey = join(homeDir, '.ssh', 'id_rsa');
		mkdirSync(join(homeDir, '.ssh'), { recursive: true });
		writeFileSync(sshKey, 'PRIVATE-KEY', 'utf-8');

		const sandbox = createTestSandbox(homeDir, workspaceDir, true);
		const agent = createTestAgent(
			[
				{
					content: '',
					toolCalls: [{ id: 'tc-3', name: 'read_file', arguments: { path: sshKey } }],
					usage: { inputTokens: 30, outputTokens: 10 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'tool_use',
				},
				{
					content: 'I cannot read that file.',
					toolCalls: [],
					usage: { inputTokens: 33, outputTokens: 12 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				},
			],
			sandbox,
		);

		await agent.processMessage('Read my SSH key', 'terminal');
		const toolResult = parseLastToolResult(agent);

		expect(toolResult.success).toBe(false);
		expect(String(toolResult.error ?? '')).toContain('denied');
	});

	it('4) "Run ls -la in my home directory" runs shell command (auto-approved)', async () => {
		const { homeDir, workspaceDir } = createScenarioDirs('case-4-shell-ls-home');
		writeFileSync(join(homeDir, 'note.txt'), 'ok', 'utf-8');

		const sandbox = createTestSandbox(homeDir, workspaceDir, true);
		const agent = createTestAgent(
			[
				{
					content: '',
					toolCalls: [
						{
							id: 'tc-4',
							name: 'execute_command',
							arguments: { command: `ls -la ${homeDir}` },
						},
					],
					usage: { inputTokens: 38, outputTokens: 13 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'tool_use',
				},
				{
					content: 'Executed ls in home directory.',
					toolCalls: [],
					usage: { inputTokens: 41, outputTokens: 13 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				},
			],
			sandbox,
		);

		await agent.processMessage('Run ls -la in my home directory', 'terminal');
		const toolResult = parseLastToolResult(agent);
		const output = toolResult.output as { stdout?: string; exitCode?: number };

		expect(toolResult.success).toBe(true);
		expect(output.exitCode).toBe(0);
		expect(output.stdout).toContain('note.txt');
	});

	it('5) "Delete all files in /tmp" is denied by shell sandbox', async () => {
		const { homeDir, workspaceDir } = createScenarioDirs('case-5-deny-rm-rf');

		const sandbox = createTestSandbox(homeDir, workspaceDir, true);
		const agent = createTestAgent(
			[
				{
					content: '',
					toolCalls: [
						{
							id: 'tc-5',
							name: 'execute_command',
							arguments: { command: 'rm -rf /tmp/*' },
						},
					],
					usage: { inputTokens: 30, outputTokens: 10 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'tool_use',
				},
				{
					content: 'That command is blocked.',
					toolCalls: [],
					usage: { inputTokens: 34, outputTokens: 12 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				},
			],
			sandbox,
		);

		await agent.processMessage('Delete all files in /tmp', 'terminal');
		const toolResult = parseLastToolResult(agent);

		expect(toolResult.success).toBe(false);
		expect(String(toolResult.error ?? '')).toContain('denied');
	});

	it('6) "What is my git status in ~/Projects/mama?" runs safe git status', async () => {
		const { homeDir, workspaceDir, repoDir } = createScenarioDirs('case-6-git-status');
		execFileSync('git', ['init'], { cwd: repoDir });
		writeFileSync(join(repoDir, 'README.md'), '# Mama', 'utf-8');

		const sandbox = createTestSandbox(homeDir, workspaceDir, true);
		const agent = createTestAgent(
			[
				{
					content: '',
					toolCalls: [
						{
							id: 'tc-6',
							name: 'execute_command',
							arguments: { command: 'git status --short', cwd: repoDir },
						},
					],
					usage: { inputTokens: 34, outputTokens: 11 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'tool_use',
				},
				{
					content: 'Got git status.',
					toolCalls: [],
					usage: { inputTokens: 37, outputTokens: 12 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				},
			],
			sandbox,
		);

		await agent.processMessage("What's my git status in ~/Projects/mama?", 'terminal');
		const toolResult = parseLastToolResult(agent);
		const output = toolResult.output as { stdout?: string; exitCode?: number };

		expect(toolResult.success).toBe(true);
		expect(output.exitCode).toBe(0);
		expect(String(output.stdout ?? '')).toContain('README.md');
	});

	it('7) multi-step request creates plan, executes, and reports progress', async () => {
		const { homeDir, workspaceDir } = createScenarioDirs('case-7-multistep-plan');
		const targetDir = join(workspaceDir, 'multi');
		const targetFile = join(targetDir, 'test.md');

		const sandbox = createTestSandbox(homeDir, workspaceDir, true);
		const planJson = JSON.stringify({
			goal: 'Create directory, write file, list directory',
			steps: [
				{
					id: 1,
					description: 'Create target directory',
					tool: 'execute_command',
					params: { command: `mkdir -p ${targetDir}` },
					dependsOn: [],
					canFail: false,
				},
				{
					id: 2,
					description: 'Write file',
					tool: 'write_file',
					params: { path: targetFile, content: 'Hello' },
					dependsOn: [1],
					canFail: false,
				},
				{
					id: 3,
					description: 'List directory',
					tool: 'list_directory',
					params: { path: targetDir },
					dependsOn: [2],
					canFail: false,
				},
			],
			hasSideEffects: true,
			estimatedDuration: '~10s',
			risks: [],
		});

		const agent = createTestAgent(
			[
				{
					content: planJson,
					toolCalls: [],
					usage: { inputTokens: 120, outputTokens: 80 },
					model: 'claude-sonnet-4-20250514',
					provider: 'claude',
					finishReason: 'end',
				},
			],
			sandbox,
		);

		const onPlanApproval = vi.fn(async () => true);
		const response = await agent.processMessage(
			'Create a directory, write a file, then list it',
			'terminal',
			{ onPlanApproval },
		);

		expect(onPlanApproval).toHaveBeenCalledTimes(1);
		expect(response.planExecution?.aborted).toBe(false);
		expect(response.planExecution?.results).toHaveLength(3);
		expect(existsSync(targetFile)).toBe(true);
		expect(readFileSync(targetFile, 'utf-8')).toBe('Hello');
		expect(response.content).toContain('Plan executed');
	});
});
