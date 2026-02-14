import { describe, expect, it } from 'vitest';
import { classifySegment, createShellCapability } from '../shell-cap.js';
import type { PermissionRequest } from '../types.js';

const config = {
	safeCommands: ['echo', 'cat', 'ls'],
	askCommands: ['mkdir', 'pnpm'],
	deniedPatterns: ['rm -rf', 'sudo'],
};

describe('shell-cap security hardening', () => {
	it('classifies shell expansion as ask (never auto)', () => {
		const classification = classifySegment('echo $(whoami)', config);
		expect(classification).toBe('ask');
	});

	it('requires approval for compound commands even if each segment is safe', () => {
		const cap = createShellCapability(config);
		const request: PermissionRequest = {
			capability: 'shell',
			action: 'run',
			resource: 'echo hello | cat',
			requestedBy: 'test',
		};

		const decision = cap.checkPermission(request);
		expect(decision.allowed).toBe(true);
		if (decision.allowed) {
			expect(decision.level).toBe('user-approved');
		}
	});

	it('denies user-approved commands when approval token is missing', async () => {
		const cap = createShellCapability(config);

		const result = await cap.execute('run', {
			command: 'mkdir /tmp/mama-shell-approval-test',
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain('Missing explicit user approval token');
		expect(result.auditEntry.result).toBe('denied');
	});

	it('still executes simple safe commands automatically', async () => {
		const cap = createShellCapability(config);

		const result = await cap.execute('run', {
			command: 'echo hello',
		});

		expect(result.success).toBe(true);
		expect((result.output as { stdout?: string }).stdout).toContain('hello');
	});

	it('redacts secrets from shell output and audit entries', async () => {
		const cap = createShellCapability(config);
		const secret = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567';

		const result = await cap.execute('run', {
			command: `echo MAMA_TELEGRAM_TOKEN=${secret}`,
		});

		expect(result.success).toBe(true);
		const output = result.output as { stdout?: string; stderr?: string };
		expect(output.stdout).toContain('MAMA_TELEGRAM_TOKEN=[REDACTED]');
		expect(output.stdout).not.toContain(secret);
		expect(result.auditEntry.output).toContain('MAMA_TELEGRAM_TOKEN=[REDACTED]');
		expect(result.auditEntry.output).not.toContain(secret);
	});
});
