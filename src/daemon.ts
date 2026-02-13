import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from './utils/logger.js';

const logger = createLogger('daemon');

export interface ManagedService {
	name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	healthCheck?(): Promise<boolean>;
}

interface DaemonOptions {
	pidFile: string;
	services: ManagedService[];
	healthCheckIntervalMs?: number;
	now?: () => Date;
}

export interface DaemonController {
	start(): Promise<void>;
	stop(): Promise<void>;
	isRunning(): boolean;
}

function writePidFile(pidFile: string, pid: number): void {
	mkdirSync(dirname(pidFile), { recursive: true });
	writeFileSync(pidFile, `${pid}\n`, 'utf-8');
}

function readPidFile(pidFile: string): number | null {
	if (!existsSync(pidFile)) return null;
	const raw = readFileSync(pidFile, 'utf-8').trim();
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function getDaemonStatus(pidFile: string): { running: boolean; pid: number | null } {
	const pid = readPidFile(pidFile);
	if (!pid) return { running: false, pid: null };
	return { running: isProcessAlive(pid), pid };
}

export function stopDaemonProcess(pidFile: string): boolean {
	const pid = readPidFile(pidFile);
	if (!pid) return false;
	try {
		process.kill(pid, 'SIGTERM');
		return true;
	} catch {
		return false;
	}
}

export function readDaemonLogs(logFile: string, lines = 100): string {
	if (!existsSync(logFile)) return '';
	const content = readFileSync(logFile, 'utf-8');
	const chunks = content.split('\n');
	return chunks.slice(-lines).join('\n').trim();
}

export function startDetachedDaemonProcess(options: {
	command: string;
	args: string[];
	cwd: string;
}): number {
	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		detached: true,
		stdio: 'ignore',
	});
	child.unref();
	return child.pid ?? -1;
}

export function createDaemonController(options: DaemonOptions): DaemonController {
	const now = options.now ?? (() => new Date());
	const healthCheckIntervalMs = Math.max(5_000, options.healthCheckIntervalMs ?? 30_000);
	let running = false;
	let healthTimer: NodeJS.Timeout | null = null;

	async function runHealthChecks(): Promise<void> {
		for (const service of options.services) {
			if (!service.healthCheck) continue;
			const healthy = await service.healthCheck();
			if (healthy) continue;

			logger.warn('Service health check failed, restarting service', {
				service: service.name,
			});
			await service.stop();
			await service.start();
		}
	}

	async function start(): Promise<void> {
		if (running) return;

		const existing = getDaemonStatus(options.pidFile);
		if (existing.running) {
			throw new Error(`Daemon already running (pid ${existing.pid})`);
		}

		writePidFile(options.pidFile, process.pid);
		for (const service of options.services) {
			await service.start();
			logger.info('Service started', { service: service.name, at: now().toISOString() });
		}
		healthTimer = setInterval(() => {
			runHealthChecks().catch((error) => {
				logger.error('Daemon health check loop failed', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, healthCheckIntervalMs);

		running = true;
	}

	async function stop(): Promise<void> {
		if (!running) {
			rmSync(options.pidFile, { force: true });
			return;
		}
		if (healthTimer) {
			clearInterval(healthTimer);
			healthTimer = null;
		}

		for (let i = options.services.length - 1; i >= 0; i--) {
			const service = options.services[i];
			if (!service) continue;
			try {
				await service.stop();
				logger.info('Service stopped', { service: service.name, at: now().toISOString() });
			} catch (error) {
				logger.error('Failed to stop service', {
					service: service.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		rmSync(options.pidFile, { force: true });
		running = false;
	}

	return {
		start,
		stop,
		isRunning: () => running,
	};
}
