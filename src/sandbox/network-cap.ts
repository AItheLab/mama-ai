import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import type {
	AuditEntry,
	Capability,
	CapabilityResult,
	PermissionDecision,
	PermissionRequest,
} from './types.js';

const logger = createLogger('sandbox:network');

const MAX_RESPONSE_BODY_LENGTH = 10_000;

export interface NetworkSandboxConfig {
	allowedDomains: string[];
	askDomains: boolean;
	rateLimitPerMinute: number;
	logAllRequests: boolean;
}

function extractDomain(url: string): string {
	return new URL(url).hostname;
}

/**
 * Creates a Network Capability for the sandbox.
 * Controls all outbound HTTP requests with domain allowlists,
 * user-approval for unknown domains, and rate limiting.
 */
export function createNetworkCapability(config: NetworkSandboxConfig): Capability {
	const sessionApprovedDomains = new Set<string>();
	const requestTimestamps: number[] = [];

	function isRateLimited(): boolean {
		const now = Date.now();
		const windowStart = now - 60_000;

		// Prune timestamps older than the window
		while (requestTimestamps.length > 0) {
			const first = requestTimestamps[0];
			if (first === undefined || first >= windowStart) break;
			requestTimestamps.shift();
		}

		return requestTimestamps.length >= config.rateLimitPerMinute;
	}

	function checkPermission(request: PermissionRequest): PermissionDecision {
		let domain: string;
		try {
			domain = extractDomain(request.resource);
		} catch {
			return { allowed: false, reason: `Invalid URL: ${request.resource}`, level: 'denied' };
		}

		if (config.allowedDomains.includes(domain) || sessionApprovedDomains.has(domain)) {
			return { allowed: true, level: 'auto' };
		}

		if (config.askDomains) {
			return { allowed: true, level: 'user-approved' };
		}

		return {
			allowed: false,
			reason: `Domain not allowed: ${domain}`,
			level: 'denied',
		};
	}

	async function execute(
		action: string,
		params: Record<string, unknown>,
	): Promise<CapabilityResult> {
		const startTime = Date.now();
		const requestedBy = (params.requestedBy as string | undefined) ?? 'agent';
		const url = params.url as string | undefined;

		if (!url || typeof url !== 'string') {
			const auditEntry = createAuditEntry({
				action,
				resource: String(url ?? ''),
				params,
				decision: 'error',
				result: 'error',
				error: 'Missing or invalid "url" parameter',
				durationMs: Date.now() - startTime,
				requestedBy,
			});
			return {
				success: false,
				output: null,
				error: 'Missing or invalid "url" parameter',
				auditEntry,
				durationMs: auditEntry.durationMs,
			};
		}

		const method = (params.method as string | undefined) ?? 'GET';
		const headers = params.headers as Record<string, string> | undefined;
		const body = params.body as string | undefined;

		// Check permission
		const permission = checkPermission({
			capability: 'network',
			action,
			resource: url,
			requestedBy,
		});

		if (!permission.allowed) {
			const auditEntry = createAuditEntry({
				action,
				resource: url,
				params: { url, method },
				decision: 'rule-denied',
				result: 'denied',
				error: permission.reason,
				durationMs: Date.now() - startTime,
				requestedBy,
			});

			logger.warn('Network request denied', {
				url,
				method,
				reason: permission.reason,
			});

			return {
				success: false,
				output: null,
				error: permission.reason,
				auditEntry,
				durationMs: auditEntry.durationMs,
			};
		}

		if (permission.level === 'user-approved' && params.__approvedByUser !== true) {
			const auditEntry = createAuditEntry({
				action,
				resource: url,
				params: { url, method },
				decision: 'rule-denied',
				result: 'denied',
				error: 'Missing explicit user approval token',
				durationMs: Date.now() - startTime,
				requestedBy,
			});

			return {
				success: false,
				output: null,
				error: 'Missing explicit user approval token',
				auditEntry,
				durationMs: auditEntry.durationMs,
			};
		}

		// Check rate limit
		if (isRateLimited()) {
			const error = `Rate limit exceeded: ${config.rateLimitPerMinute} requests per minute`;
			const auditEntry = createAuditEntry({
				action,
				resource: url,
				params: { url, method },
				decision: 'rule-denied',
				result: 'error',
				error,
				durationMs: Date.now() - startTime,
				requestedBy,
			});

			logger.warn('Network rate limit exceeded', {
				url,
				method,
				rateLimitPerMinute: config.rateLimitPerMinute,
			});

			return {
				success: false,
				output: null,
				error,
				auditEntry,
				durationMs: auditEntry.durationMs,
			};
		}

		// Execute the fetch
		try {
			const fetchOptions: RequestInit = { method };

			if (headers) {
				fetchOptions.headers = headers;
			}

			if (body && method !== 'GET' && method !== 'HEAD') {
				fetchOptions.body = body;
			}

			const response = await fetch(url, fetchOptions);

			// Record timestamp for rate limiting
			requestTimestamps.push(Date.now());

			const responseBody = await response.text();
			const truncatedBody =
				responseBody.length > MAX_RESPONSE_BODY_LENGTH
					? `${responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH)}... [truncated, ${responseBody.length} total chars]`
					: responseBody;

			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				responseHeaders[key] = value;
			});

			const output = {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
				body: truncatedBody,
			};

			const durationMs = Date.now() - startTime;
			const decision = permission.level === 'user-approved' ? 'user-approved' : 'auto-approved';

			const auditEntry = createAuditEntry({
				action,
				resource: url,
				params: { url, method },
				decision,
				result: 'success',
				output: `HTTP ${response.status} ${response.statusText}`,
				durationMs,
				requestedBy,
			});

			// Add domain to session-approved on success
			try {
				const domain = extractDomain(url);
				sessionApprovedDomains.add(domain);
			} catch {
				// Domain extraction already validated above, but be defensive
			}

			if (config.logAllRequests) {
				logger.info('Network request completed', {
					url,
					method,
					status: response.status,
					durationMs,
				});
			} else {
				logger.debug('Network request completed', {
					url,
					method,
					status: response.status,
					durationMs,
				});
			}

			return {
				success: true,
				output,
				auditEntry,
				durationMs,
			};
		} catch (err: unknown) {
			const durationMs = Date.now() - startTime;
			const errorMessage = err instanceof Error ? err.message : String(err);

			const auditEntry = createAuditEntry({
				action,
				resource: url,
				params: { url, method },
				decision: 'error',
				result: 'error',
				error: errorMessage,
				durationMs,
				requestedBy,
			});

			logger.error('Network request failed', {
				url,
				method,
				error: errorMessage,
				durationMs,
			});

			return {
				success: false,
				output: null,
				error: errorMessage,
				auditEntry,
				durationMs,
			};
		}
	}

	function createAuditEntry(fields: {
		action: string;
		resource: string;
		params: Record<string, unknown>;
		decision: AuditEntry['decision'];
		result: AuditEntry['result'];
		output?: string;
		error?: string;
		durationMs: number;
		requestedBy: string;
	}): AuditEntry {
		return {
			id: uuidv4(),
			timestamp: new Date(),
			capability: 'network',
			action: fields.action,
			resource: fields.resource,
			params: fields.params,
			decision: fields.decision,
			result: fields.result,
			output: fields.output,
			error: fields.error,
			durationMs: fields.durationMs,
			requestedBy: fields.requestedBy,
		};
	}

	return {
		name: 'network',
		description: 'Controlled outbound HTTP requests with domain allowlists and rate limiting',
		checkPermission,
		execute,
	};
}
