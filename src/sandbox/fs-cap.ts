import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import micromatch from 'micromatch';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import type {
	AuditEntry,
	Capability,
	CapabilityResult,
	PermissionDecision,
	PermissionRequest,
} from './types.js';

const logger = createLogger('sandbox:fs');

/** Max bytes to store in audit output field */
const AUDIT_OUTPUT_MAX_BYTES = 1024;

interface FsPathRule {
	path: string;
	actions: string[];
	level: 'auto' | 'ask' | 'deny';
}

interface FilesystemSandboxConfig {
	workspace: string;
	allowedPaths: FsPathRule[];
	deniedPaths: string[];
}

/**
 * Resolves `~` at the start of a path to the given home directory.
 */
function expandTilde(filePath: string, homePath: string): string {
	if (filePath === '~') {
		return homePath;
	}
	if (filePath.startsWith('~/')) {
		return path.join(homePath, filePath.slice(2));
	}
	return filePath;
}

/**
 * Truncates a string to the given max byte length.
 * Ensures we don't cut in the middle of a multi-byte character.
 */
function truncateOutput(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf-8') <= maxBytes) {
		return value;
	}
	const buf = Buffer.from(value, 'utf-8');
	// Slice to maxBytes and decode back; invalid trailing bytes are replaced
	const truncated = buf.subarray(0, maxBytes).toString('utf-8');
	return `${truncated}... [truncated]`;
}

/**
 * Detects suspicious path traversal.
 * If the raw path contains `..` segments and the resolved path escapes what
 * we would expect from the raw path's starting directory, flag it.
 */
function isPathTraversal(rawPath: string, resolvedPath: string, homePath: string): boolean {
	if (!rawPath.includes('..')) {
		return false;
	}
	// Expand tilde in the raw path to get the "intended" starting point
	const expanded = expandTilde(rawPath, homePath);
	// The resolved path should be a descendant of the raw path's parent directory
	const expectedParent = path.dirname(path.resolve(expanded.split('..')[0] ?? expanded));
	// If the resolved path is not under the expected parent, it's suspicious
	if (!resolvedPath.startsWith(expectedParent)) {
		return true;
	}
	return false;
}

/**
 * Creates a Filesystem Capability for the sandbox.
 *
 * All file system access from the agent routes through this capability,
 * which enforces path-based permissions and generates audit entries.
 */
export function createFsCapability(config: FilesystemSandboxConfig, homePath: string): Capability {
	// Pre-resolve config paths
	const resolvedWorkspace = path.resolve(expandTilde(config.workspace, homePath));
	const resolvedDeniedPatterns = config.deniedPaths.map((p) =>
		path.resolve(expandTilde(p, homePath)),
	);
	const resolvedAllowedRules = config.allowedPaths.map((rule) => ({
		...rule,
		resolvedPattern: path.resolve(expandTilde(rule.path, homePath)),
	}));

	function resolveFsPath(rawPath: string): string {
		const expanded = expandTilde(rawPath, homePath);
		return path.resolve(expanded);
	}

	function resolveActionPath(
		resolvedPath: string,
		action: string,
	): { ok: true; path: string } | { ok: false; reason: string } {
		try {
			if (action === 'write') {
				// For new files, resolve symlinks in parent directories to prevent escapes.
				if (!existsSync(resolvedPath)) {
					const parent = path.dirname(resolvedPath);
					const realParent = realpathSync(parent);
					return { ok: true, path: path.join(realParent, path.basename(resolvedPath)) };
				}
			}

			return { ok: true, path: realpathSync(resolvedPath) };
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : 'Failed to resolve real path';
			return { ok: false, reason };
		}
	}

	function checkPermission(request: PermissionRequest): PermissionDecision {
		const resolvedPath = resolveFsPath(request.resource);
		const actionPath = resolveActionPath(resolvedPath, request.action);

		if (!actionPath.ok) {
			return {
				allowed: false,
				reason: `Path resolution failed for "${request.resource}": ${actionPath.reason}`,
				level: 'denied',
			};
		}
		const effectivePath = actionPath.path;

		// Detect path traversal
		if (isPathTraversal(request.resource, effectivePath, homePath)) {
			logger.warn('Path traversal detected', {
				raw: request.resource,
				resolved: effectivePath,
			});
			return {
				allowed: false,
				reason: `Path traversal detected: ${request.resource} resolves to ${effectivePath}`,
				level: 'denied',
			};
		}

		// 1. Check denied paths FIRST (always wins)
		for (const deniedPattern of resolvedDeniedPatterns) {
			if (micromatch.isMatch(effectivePath, deniedPattern)) {
				logger.debug('Path denied by rule', {
					path: effectivePath,
					pattern: deniedPattern,
				});
				return {
					allowed: false,
					reason: `Path is denied: ${request.resource}`,
					level: 'denied',
				};
			}
		}

		// 2. Workspace is always allowed (auto level)
		if (effectivePath === resolvedWorkspace || effectivePath.startsWith(`${resolvedWorkspace}/`)) {
			return { allowed: true, level: 'auto' };
		}

		// 3. Check allowed paths: find matching rule by glob + action
		for (const rule of resolvedAllowedRules) {
			const matchesPath = micromatch.isMatch(effectivePath, rule.resolvedPattern);
			const matchesAction = rule.actions.includes(request.action);

			if (matchesPath && matchesAction) {
				if (rule.level === 'deny') {
					return {
						allowed: false,
						reason: `Rule explicitly denies ${request.action} on ${request.resource}`,
						level: 'denied',
					};
				}

				const level: 'auto' | 'user-approved' = rule.level === 'ask' ? 'user-approved' : 'auto';

				return { allowed: true, level };
			}
		}

		// 4. No rule matches -> deny
		return {
			allowed: false,
			reason: `No rule allows '${request.action}' on ${request.resource}`,
			level: 'denied',
		};
	}

	async function execute(
		action: string,
		params: Record<string, unknown>,
	): Promise<CapabilityResult> {
		const rawPath = params.path as string | undefined;

		if (!rawPath) {
			const auditEntry = createAuditEntry(
				action,
				'',
				params,
				'rule-denied',
				'error',
				0,
				undefined,
				'Missing required parameter: path',
			);
			return {
				success: false,
				output: null,
				error: 'Missing required parameter: path',
				auditEntry,
				durationMs: 0,
			};
		}

		const resolvedPath = resolveFsPath(rawPath);

		// Check permission internally before executing
		const permRequest: PermissionRequest = {
			capability: 'filesystem',
			action,
			resource: rawPath,
			requestedBy: (params.requestedBy as string | undefined) ?? 'agent',
		};
		const decision = checkPermission(permRequest);

		if (!decision.allowed) {
			const auditEntry = createAuditEntry(
				action,
				resolvedPath,
				params,
				'rule-denied',
				'denied',
				0,
				undefined,
				decision.reason,
			);
			logger.warn('Filesystem access denied', {
				action,
				path: resolvedPath,
				reason: decision.reason,
			});
			return {
				success: false,
				output: null,
				error: decision.reason,
				auditEntry,
				durationMs: 0,
			};
		}

		if (decision.level === 'user-approved' && params.__approvedByUser !== true) {
			const auditEntry = createAuditEntry(
				action,
				resolvedPath,
				params,
				'rule-denied',
				'denied',
				0,
				undefined,
				'Missing explicit user approval token',
				permRequest.requestedBy,
			);
			return {
				success: false,
				output: null,
				error: 'Missing explicit user approval token',
				auditEntry,
				durationMs: 0,
			};
		}

		const actionPath = resolveActionPath(resolvedPath, action);
		if (!actionPath.ok) {
			const auditEntry = createAuditEntry(
				action,
				resolvedPath,
				params,
				'error',
				'error',
				0,
				undefined,
				`Path resolution failed: ${actionPath.reason}`,
				permRequest.requestedBy,
			);
			return {
				success: false,
				output: null,
				error: `Path resolution failed: ${actionPath.reason}`,
				auditEntry,
				durationMs: 0,
			};
		}
		const executionPath = actionPath.path;

		const start = Date.now();

		try {
			let output: unknown;
			let outputStr: string;

			switch (action) {
				case 'read': {
					const content = readFileSync(executionPath, 'utf-8');
					output = content;
					outputStr = content;
					break;
				}
				case 'write': {
					const content = (params.content as string) ?? '';
					writeFileSync(executionPath, content, 'utf-8');
					const bytesWritten = Buffer.byteLength(content, 'utf-8');
					output = { bytesWritten };
					outputStr = `${String(bytesWritten)} bytes written`;
					break;
				}
				case 'list': {
					const entries = readdirSync(executionPath);
					output = entries;
					outputStr = entries.join('\n');
					break;
				}
				case 'delete': {
					unlinkSync(executionPath);
					output = { deleted: true };
					outputStr = `Deleted ${executionPath}`;
					break;
				}
				default: {
					const durationMs = Date.now() - start;
					const auditEntry = createAuditEntry(
						action,
						executionPath,
						params,
						'rule-denied',
						'error',
						durationMs,
						undefined,
						`Unknown action: ${action}`,
					);
					return {
						success: false,
						output: null,
						error: `Unknown action: ${action}`,
						auditEntry,
						durationMs,
					};
				}
			}

			const durationMs = Date.now() - start;
			const decisionLabel: AuditEntry['decision'] =
				decision.level === 'user-approved' ? 'user-approved' : 'auto-approved';
			const auditEntry = createAuditEntry(
				action,
				executionPath,
				params,
				decisionLabel,
				'success',
				durationMs,
				truncateOutput(outputStr, AUDIT_OUTPUT_MAX_BYTES),
				undefined,
				permRequest.requestedBy,
			);

			logger.debug('Filesystem action executed', {
				action,
				path: executionPath,
				durationMs,
			});

			return {
				success: true,
				output,
				auditEntry,
				durationMs,
			};
		} catch (err: unknown) {
			const durationMs = Date.now() - start;
			const errorMessage =
				err instanceof Error ? err.message : 'Unknown error during filesystem operation';

			logger.error('Filesystem action failed', {
				action,
				path: executionPath,
				error: errorMessage,
			});

			const auditEntry = createAuditEntry(
				action,
				executionPath,
				params,
				'error',
				'error',
				durationMs,
				undefined,
				errorMessage,
				permRequest.requestedBy,
			);

			return {
				success: false,
				output: null,
				error: errorMessage,
				auditEntry,
				durationMs,
			};
		}
	}

	function createAuditEntry(
		action: string,
		resource: string,
		params: Record<string, unknown>,
		decision: AuditEntry['decision'],
		result: AuditEntry['result'],
		durationMs: number,
		output?: string,
		error?: string,
		requestedBy?: string,
	): AuditEntry {
		return {
			id: uuidv4(),
			timestamp: new Date(),
			capability: 'filesystem',
			action,
			resource,
			params,
			decision,
			result,
			output,
			error,
			durationMs,
			requestedBy: requestedBy ?? 'agent',
		};
	}

	return {
		name: 'filesystem',
		description: 'Controls file system access: read, write, list, and delete operations',
		checkPermission,
		execute,
	};
}
