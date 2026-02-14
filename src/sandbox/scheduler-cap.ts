import { v4 as uuidv4 } from 'uuid';
import { getScheduler } from '../scheduler/registry.js';
import { createLogger } from '../utils/logger.js';
import type {
	AuditEntry,
	Capability,
	CapabilityResult,
	PermissionDecision,
	PermissionRequest,
} from './types.js';

const logger = createLogger('sandbox:scheduler');

export interface SchedulerSandboxConfig {
	// Future-proof: allow making some scheduler actions auto/ask/deny via config.
	allowList?: boolean;
}

type SchedulerAction = 'list_jobs' | 'create_job' | 'manage_job';

function isSchedulerAction(value: string): value is SchedulerAction {
	return value === 'list_jobs' || value === 'create_job' || value === 'manage_job';
}

export function createSchedulerCapability(_config: SchedulerSandboxConfig = {}): Capability {
	function checkPermission(request: PermissionRequest): PermissionDecision {
		const action = request.action;
		if (!isSchedulerAction(action)) {
			return { allowed: false, reason: `Unknown scheduler action: ${action}`, level: 'denied' };
		}

		if (action === 'list_jobs') {
			return { allowed: true, level: 'auto' };
		}

		// Persistent state changes always require explicit approval.
		return { allowed: true, level: 'user-approved' };
	}

	async function execute(
		action: string,
		params: Record<string, unknown>,
	): Promise<CapabilityResult> {
		const requestedBy = (params.requestedBy as string | undefined) ?? 'agent';
		const start = Date.now();

		// Defense in depth: require explicit approval token for state-changing actions,
		// even if sandbox layer is bypassed.
		if ((action === 'create_job' || action === 'manage_job') && params.__approvedByUser !== true) {
			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'scheduler',
				action,
				resource: '',
				params: { ...params, requestedBy },
				decision: 'rule-denied',
				result: 'denied',
				error: 'Missing explicit user approval token',
				durationMs: Date.now() - start,
				requestedBy,
			};
			return {
				success: false,
				output: null,
				error: entry.error,
				auditEntry: entry,
				durationMs: entry.durationMs,
			};
		}

		if (!isSchedulerAction(action)) {
			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'scheduler',
				action,
				resource: '',
				params: { ...params, requestedBy },
				decision: 'rule-denied',
				result: 'error',
				error: `Unknown scheduler action: ${action}`,
				durationMs: 0,
				requestedBy,
			};
			return { success: false, output: null, error: entry.error, auditEntry: entry, durationMs: 0 };
		}

		const scheduler = getScheduler();
		if (!scheduler) {
			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'scheduler',
				action,
				resource: '',
				params: { ...params, requestedBy },
				decision: 'error',
				result: 'error',
				error: 'Scheduler is not available.',
				durationMs: Date.now() - start,
				requestedBy,
			};
			return {
				success: false,
				output: null,
				error: entry.error,
				auditEntry: entry,
				durationMs: entry.durationMs,
			};
		}

		try {
			if (action === 'list_jobs') {
				const jobs = await scheduler.listJobs();
				const entry: AuditEntry = {
					id: uuidv4(),
					timestamp: new Date(),
					capability: 'scheduler',
					action,
					resource: '',
					params: { requestedBy },
					decision: 'auto-approved',
					result: 'success',
					output: `jobs=${jobs.length}`,
					durationMs: Date.now() - start,
					requestedBy,
				};
				return { success: true, output: jobs, auditEntry: entry, durationMs: entry.durationMs };
			}

			if (action === 'create_job') {
				const schedule = String(params.schedule ?? '').trim();
				const task = String(params.task ?? '').trim();
				const name = typeof params.name === 'string' ? params.name : undefined;
				if (!schedule || !task) {
					throw new Error('schedule and task are required');
				}
				const id = await scheduler.createJob({ name, schedule, task });
				const created = await scheduler.getJob(id);
				const entry: AuditEntry = {
					id: uuidv4(),
					timestamp: new Date(),
					capability: 'scheduler',
					action,
					resource: id,
					params: { name, schedule, task: `[${task.length} chars]`, requestedBy },
					decision: params.__approvedByUser === true ? 'user-approved' : 'auto-approved',
					result: 'success',
					output: `created=${id}`,
					durationMs: Date.now() - start,
					requestedBy,
				};
				return { success: true, output: created, auditEntry: entry, durationMs: entry.durationMs };
			}

			if (action === 'manage_job') {
				const id = String(params.id ?? '').trim();
				const op = String(params.action ?? '').trim();
				if (!id || !['enable', 'disable', 'delete'].includes(op)) {
					throw new Error('id and action are required');
				}
				if (op === 'enable') await scheduler.enableJob(id);
				if (op === 'disable') await scheduler.disableJob(id);
				if (op === 'delete') await scheduler.deleteJob(id);

				const entry: AuditEntry = {
					id: uuidv4(),
					timestamp: new Date(),
					capability: 'scheduler',
					action,
					resource: id,
					params: { id, action: op, requestedBy },
					decision: params.__approvedByUser === true ? 'user-approved' : 'auto-approved',
					result: 'success',
					output: `${op}=${id}`,
					durationMs: Date.now() - start,
					requestedBy,
				};
				return {
					success: true,
					output: { id, action: op },
					auditEntry: entry,
					durationMs: entry.durationMs,
				};
			}

			// Unreachable by isSchedulerAction guard.
			throw new Error('Unsupported scheduler action');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('Scheduler capability execution failed', { action, error: message });
			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'scheduler',
				action,
				resource: String(params.id ?? ''),
				params: { ...params, requestedBy },
				decision: 'error',
				result: 'error',
				error: message,
				durationMs: Date.now() - start,
				requestedBy,
			};
			return {
				success: false,
				output: null,
				error: message,
				auditEntry: entry,
				durationMs: entry.durationMs,
			};
		}
	}

	return {
		name: 'scheduler',
		description: 'Controls scheduled job creation and management (persistent state)',
		checkPermission,
		execute,
	};
}
