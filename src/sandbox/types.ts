/** Audit entry for every capability execution */
export interface AuditEntry {
	id: string;
	timestamp: Date;
	capability: string;
	action: string;
	resource: string;
	params?: Record<string, unknown>;
	decision: 'auto-approved' | 'user-approved' | 'user-denied' | 'rule-denied' | 'error';
	result: 'success' | 'denied' | 'error';
	output?: string;
	error?: string;
	durationMs: number;
	requestedBy: string;
}

/** What the agent wants to do */
export interface PermissionRequest {
	capability: string;
	action: string;
	resource: string;
	context?: string;
	requestedBy: string;
}

/** The sandbox's decision */
export type PermissionDecision =
	| { allowed: true; level: 'auto' | 'user-approved' }
	| { allowed: false; reason: string; level: 'denied' };

/** Result of every capability execution */
export interface CapabilityResult {
	success: boolean;
	output: unknown;
	error?: string;
	auditEntry: AuditEntry;
	durationMs: number;
}

/** A Capability wraps a type of system access */
export interface Capability {
	name: string;
	description: string;
	checkPermission(request: PermissionRequest): PermissionDecision;
	execute(action: string, params: Record<string, unknown>): Promise<CapabilityResult>;
}

/** Request for user approval */
export interface ApprovalRequest {
	capability: string;
	action: string;
	resource: string;
	context?: string;
	details?: string;
}

/** Function to request user approval — injected by the active channel */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;
