import { describe, expect, it, vi } from 'vitest';
import { createSandbox } from '../sandbox.js';
import type { Capability, CapabilityResult, PermissionRequest } from '../types.js';

function createMockCapability(name: string, allowAll = true): Capability {
	return {
		name,
		description: `Mock ${name} capability`,
		checkPermission: vi.fn((_req: PermissionRequest) => {
			if (allowAll) {
				return { allowed: true as const, level: 'auto' as const };
			}
			return { allowed: false as const, reason: 'Denied by mock', level: 'denied' as const };
		}),
		execute: vi.fn(
			async (_action: string, _params: Record<string, unknown>): Promise<CapabilityResult> => ({
				success: true,
				output: 'mock output',
				durationMs: 1,
				auditEntry: {
					id: 'test-id',
					timestamp: new Date(),
					capability: name,
					action: _action,
					resource: '',
					decision: 'auto-approved',
					result: 'success',
					durationMs: 1,
					requestedBy: 'agent',
				},
			}),
		),
	};
}

describe('Sandbox', () => {
	it('registers and retrieves capabilities', () => {
		const sandbox = createSandbox();
		const cap = createMockCapability('test');
		sandbox.register(cap);

		expect(sandbox.getCapability('test')).toBe(cap);
		expect(sandbox.getCapabilities()).toHaveLength(1);
	});

	it('denies unknown capabilities', () => {
		const sandbox = createSandbox();
		const decision = sandbox.check('nonexistent', 'read', '/tmp');

		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toContain('Unknown capability');
		}
	});

	it('routes check to correct capability', () => {
		const sandbox = createSandbox();
		const cap = createMockCapability('filesystem');
		sandbox.register(cap);

		sandbox.check('filesystem', 'read', '/home/file.txt');

		expect(cap.checkPermission).toHaveBeenCalledOnce();
	});

	it('executes capability and returns result', async () => {
		const sandbox = createSandbox();
		const cap = createMockCapability('filesystem');
		sandbox.register(cap);

		const result = await sandbox.execute('filesystem', 'read', { path: '/tmp/test' });

		expect(result.success).toBe(true);
		expect(result.output).toBe('mock output');
	});

	it('denies execution for unknown capability', async () => {
		const sandbox = createSandbox();
		const result = await sandbox.execute('nonexistent', 'read', { path: '/tmp' });

		expect(result.success).toBe(false);
		expect(result.error).toContain('Unknown capability');
	});

	it('denies execution when permission check fails', async () => {
		const sandbox = createSandbox();
		const cap = createMockCapability('filesystem', false);
		sandbox.register(cap);

		const result = await sandbox.execute('filesystem', 'read', { path: '/root/secret' });

		expect(result.success).toBe(false);
		expect(result.error).toContain('Denied by mock');
	});

	it('logs audit entries when audit store provided', async () => {
		const mockAudit = { log: vi.fn() };
		const sandbox = createSandbox(mockAudit);
		const cap = createMockCapability('filesystem');
		sandbox.register(cap);

		await sandbox.execute('filesystem', 'read', { path: '/tmp/test' });

		expect(mockAudit.log).toHaveBeenCalledOnce();
	});

	it('handles approval flow when handler set', async () => {
		const sandbox = createSandbox();

		// Create capability that requires approval
		const cap: Capability = {
			name: 'filesystem',
			description: 'Test',
			checkPermission: () => ({ allowed: true, level: 'user-approved' }),
			execute: vi.fn(async () => ({
				success: true,
				output: 'done',
				durationMs: 1,
				auditEntry: {
					id: 'test',
					timestamp: new Date(),
					capability: 'filesystem',
					action: 'write',
					resource: '/tmp/file',
					decision: 'user-approved' as const,
					result: 'success' as const,
					durationMs: 1,
					requestedBy: 'agent',
				},
			})),
		};

		sandbox.register(cap);
		sandbox.setApprovalHandler(async () => true);

		const result = await sandbox.execute('filesystem', 'write', { path: '/tmp/file' });
		expect(result.success).toBe(true);
	});

	it('denies when user rejects approval', async () => {
		const sandbox = createSandbox();

		const cap: Capability = {
			name: 'filesystem',
			description: 'Test',
			checkPermission: () => ({ allowed: true, level: 'user-approved' }),
			execute: vi.fn(async () => ({
				success: true,
				output: 'done',
				durationMs: 1,
				auditEntry: {
					id: 'test',
					timestamp: new Date(),
					capability: 'filesystem',
					action: 'write',
					resource: '/tmp/file',
					decision: 'user-approved' as const,
					result: 'success' as const,
					durationMs: 1,
					requestedBy: 'agent',
				},
			})),
		};

		sandbox.register(cap);
		sandbox.setApprovalHandler(async () => false);

		const result = await sandbox.execute('filesystem', 'write', { path: '/tmp/file' });
		expect(result.success).toBe(false);
		expect(result.error).toContain('User denied');
	});

	it('injects explicit approval token before executing ask-level capability', async () => {
		const sandbox = createSandbox();
		let receivedParams: Record<string, unknown> | undefined;

		const cap: Capability = {
			name: 'shell',
			description: 'Test',
			checkPermission: () => ({ allowed: true, level: 'user-approved' }),
			execute: vi.fn(async (_action, params) => {
				receivedParams = params;
				return {
					success: true,
					output: 'ok',
					durationMs: 1,
					auditEntry: {
						id: 'test',
						timestamp: new Date(),
						capability: 'shell',
						action: _action,
						resource: String(params.command ?? ''),
						decision: 'user-approved',
						result: 'success',
						durationMs: 1,
						requestedBy: String(params.requestedBy ?? 'agent'),
					},
				};
			}),
		};

		sandbox.register(cap);
		sandbox.setApprovalHandler(async () => true);

		const result = await sandbox.execute('shell', 'run', { command: 'echo test' }, 'tester');
		expect(result.success).toBe(true);
		expect(receivedParams?.__approvedByUser).toBe(true);
		expect(receivedParams?.requestedBy).toBe('tester');
	});
});
