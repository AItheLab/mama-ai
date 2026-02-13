import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonController } from '../daemon.js';

const tempRoots: string[] = [];

function createTempPidFile(): string {
	const root = mkdtempSync(join(tmpdir(), 'mama-daemon-test-'));
	tempRoots.push(root);
	return join(root, 'mama.pid');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
	vi.useRealTimers();
});

describe('createDaemonController', () => {
	it('starts daemon, initializes services in order, and creates PID file', async () => {
		const pidFile = createTempPidFile();
		const order: string[] = [];
		const controller = createDaemonController({
			pidFile,
			services: [
				{
					name: 'scheduler',
					start: vi.fn(async () => order.push('start:scheduler')),
					stop: vi.fn(async () => order.push('stop:scheduler')),
				},
				{
					name: 'api',
					start: vi.fn(async () => order.push('start:api')),
					stop: vi.fn(async () => order.push('stop:api')),
				},
			],
		});

		await controller.start();
		expect(existsSync(pidFile)).toBe(true);
		expect(order).toEqual(['start:scheduler', 'start:api']);
		const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
		expect(pid).toBe(process.pid);

		await controller.stop();
		expect(existsSync(pidFile)).toBe(false);
		expect(order).toEqual(['start:scheduler', 'start:api', 'stop:api', 'stop:scheduler']);
	});

	it('restarts unhealthy services during health checks', async () => {
		vi.useFakeTimers();
		const pidFile = createTempPidFile();
		let healthChecks = 0;
		const start = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const controller = createDaemonController({
			pidFile,
			healthCheckIntervalMs: 5_000,
			services: [
				{
					name: 'heartbeat',
					start,
					stop,
					healthCheck: vi.fn(async () => {
						healthChecks++;
						return healthChecks > 1;
					}),
				},
			],
		});

		await controller.start();
		await vi.advanceTimersByTimeAsync(5_000);
		await Promise.resolve();

		expect(stop).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(2);

		await controller.stop();
	});
});
