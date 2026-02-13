import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeartbeat } from '../heartbeat.js';

describe('createHeartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs heartbeat and sends checklist + system state prompt to agent task runner', async () => {
		const runTask = vi.fn(async () => ({ success: true, output: 'nothing to do' }));
		const heartbeat = createHeartbeat({
			intervalMinutes: 30,
			heartbeatFile: '/tmp/heartbeat.md',
			readChecklist: async () => '# Checks\n- Item A',
			runTask,
		});

		const report = await heartbeat.runOnce();

		expect(runTask).toHaveBeenCalledTimes(1);
		const prompt = runTask.mock.calls[0]?.[0] ?? '';
		expect(prompt).toContain('Review these heartbeat items');
		expect(prompt).toContain('Item A');
		expect(prompt).toContain('Current system state');
		expect(report.result.success).toBe(true);
	});

	it('triggers periodically at configured interval', async () => {
		const runTask = vi.fn(async () => ({ success: true }));
		const heartbeat = createHeartbeat({
			intervalMinutes: 1,
			heartbeatFile: '/tmp/heartbeat.md',
			readChecklist: async () => '# Checks',
			runTask,
		});

		heartbeat.start();
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(60_000);
		heartbeat.stop();

		expect(runTask).toHaveBeenCalledTimes(2);
	});

	it('logs heartbeat runs to audit store and supports no-op actions', async () => {
		const auditEntries: Array<{ capability: string; result: string }> = [];
		const heartbeat = createHeartbeat({
			intervalMinutes: 30,
			heartbeatFile: '/tmp/heartbeat.md',
			readChecklist: async () => '# Checks',
			runTask: async () => ({ success: true, output: { actionTaken: false } }),
			auditStore: {
				log(entry) {
					auditEntries.push({ capability: entry.capability, result: entry.result });
				},
			},
		});

		const report = await heartbeat.runOnce();
		expect(report.result.success).toBe(true);
		expect(auditEntries).toEqual([{ capability: 'heartbeat', result: 'success' }]);
	});
});
