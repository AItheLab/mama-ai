import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import type {
	ApprovalHandler,
	ApprovalRequest,
	AuditEntry,
	Capability,
	CapabilityResult,
	PermissionDecision,
	PermissionRequest,
} from './types.js';

const logger = createLogger('sandbox');

interface AuditStore {
	log(entry: AuditEntry): void;
}

interface Sandbox {
	register(capability: Capability): void;
	check(
		capName: string,
		action: string,
		resource: string,
		requestedBy?: string,
	): PermissionDecision;
	execute(
		capName: string,
		action: string,
		params: Record<string, unknown>,
		requestedBy?: string,
	): Promise<CapabilityResult>;
	setApprovalHandler(handler: ApprovalHandler): void;
	getCapability(name: string): Capability | undefined;
	getCapabilities(): Capability[];
}

/**
 * Creates the central Capability Sandbox.
 * All system access routes through here.
 */
export function createSandbox(auditStore?: AuditStore): Sandbox {
	const capabilities = new Map<string, Capability>();
	let approvalHandler: ApprovalHandler | null = null;

	function register(capability: Capability): void {
		capabilities.set(capability.name, capability);
		logger.info('Capability registered', { name: capability.name });
	}

	function check(
		capName: string,
		action: string,
		resource: string,
		requestedBy = 'agent',
	): PermissionDecision {
		const capability = capabilities.get(capName);
		if (!capability) {
			return { allowed: false, reason: `Unknown capability: ${capName}`, level: 'denied' };
		}

		const request: PermissionRequest = {
			capability: capName,
			action,
			resource,
			requestedBy,
		};

		return capability.checkPermission(request);
	}

	async function execute(
		capName: string,
		action: string,
		params: Record<string, unknown>,
		requestedBy = 'agent',
	): Promise<CapabilityResult> {
		const baseParams: Record<string, unknown> = { ...params, requestedBy };
		const capability = capabilities.get(capName);
		if (!capability) {
			const entry = createDeniedAuditEntry(
				capName,
				action,
				baseParams,
				`Unknown capability: ${capName}`,
				requestedBy,
			);
			auditStore?.log(entry);
			return {
				success: false,
				output: null,
				error: `Unknown capability: ${capName}`,
				auditEntry: entry,
				durationMs: 0,
			};
		}

		const resource = (baseParams.path ?? baseParams.command ?? baseParams.url ?? '') as string;
		const permission = check(capName, action, resource, requestedBy);

		if (!permission.allowed) {
			logger.warn('Capability denied', {
				capability: capName,
				action,
				resource,
				reason: permission.reason,
			});
			const entry = createDeniedAuditEntry(
				capName,
				action,
				baseParams,
				permission.reason,
				requestedBy,
			);
			auditStore?.log(entry);
			return {
				success: false,
				output: null,
				error: permission.reason,
				auditEntry: entry,
				durationMs: 0,
			};
		}

		// If level is 'user-approved' we need actual user approval (ask level from config)
		// This is handled inside each capability, but we also support it here
		if (permission.level === 'user-approved' || (permission.level as string) === 'ask') {
			if (!approvalHandler) {
				const entry = createDeniedAuditEntry(
					capName,
					action,
					baseParams,
					'No approval handler available',
					requestedBy,
				);
				auditStore?.log(entry);
				return {
					success: false,
					output: null,
					error: 'No approval handler available',
					auditEntry: entry,
					durationMs: 0,
				};
			}

			const approvalReq: ApprovalRequest = {
				capability: capName,
				action,
				resource,
				context: baseParams.context as string | undefined,
			};

			const approved = await approvalHandler(approvalReq);
			if (!approved) {
				logger.info('User denied capability', { capability: capName, action, resource });
				const entry: AuditEntry = {
					id: uuidv4(),
					timestamp: new Date(),
					capability: capName,
					action,
					resource,
					params: baseParams,
					decision: 'user-denied',
					result: 'denied',
					durationMs: 0,
					requestedBy,
				};
				auditStore?.log(entry);
				return {
					success: false,
					output: null,
					error: 'User denied the action',
					auditEntry: entry,
					durationMs: 0,
				};
			}
		}

		const executionParams =
			permission.level === 'user-approved'
				? ({ ...baseParams, __approvedByUser: true } as Record<string, unknown>)
				: baseParams;

		// Execute the capability
		const result = await capability.execute(action, executionParams);
		auditStore?.log(result.auditEntry);

		logger.info('Capability executed', {
			capability: capName,
			action,
			resource,
			success: result.success,
			durationMs: result.durationMs,
		});

		return result;
	}

	function setApprovalHandler(handler: ApprovalHandler): void {
		approvalHandler = handler;
	}

	return {
		register,
		check,
		execute,
		setApprovalHandler,
		getCapability: (name) => capabilities.get(name),
		getCapabilities: () => [...capabilities.values()],
	};
}

function createDeniedAuditEntry(
	capability: string,
	action: string,
	params: Record<string, unknown>,
	reason: string,
	requestedBy: string,
): AuditEntry {
	return {
		id: uuidv4(),
		timestamp: new Date(),
		capability,
		action,
		resource: (params.path ?? params.command ?? params.url ?? '') as string,
		params,
		decision: 'rule-denied',
		result: 'denied',
		error: reason,
		durationMs: 0,
		requestedBy,
	};
}
