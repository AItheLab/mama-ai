import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
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
const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 5000;

function sanitizeParamsForAudit(
	action: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	if (action === 'write') {
		const content = typeof params.content === 'string' ? params.content : '';
		const copy: Record<string, unknown> = { ...params };
		delete copy.content;
		copy.contentLength = Buffer.byteLength(content, 'utf-8');
		return copy;
	}
	if (action === 'read') {
		const copy: Record<string, unknown> = { ...params };
		delete copy.content;
		return copy;
	}
	return { ...params };
}

function walkSearch(
	root: string,
	pattern: string,
	limit: number,
): { matches: string[]; truncated: boolean } {
	const matches: string[] = [];
	let truncated = false;

	const queue: string[] = [root];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(current, {
				withFileTypes: true,
			}) as unknown as import('node:fs').Dirent[];
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (matches.length >= limit) {
				truncated = true;
				return { matches, truncated };
			}

			// Don't follow symlinks during recursive search.
			if (entry.isSymbolicLink()) {
				continue;
			}

			const name = String(entry.name);
			const fullPath = path.join(current, name);
			if (micromatch.isMatch(name, pattern)) {
				matches.push(fullPath);
			}
			if (entry.isDirectory()) {
				queue.push(fullPath);
			}
		}
	}

	return { matches, truncated };
}

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
 * Checks for `..` segments that escape the starting directory, and for
 * null bytes which can truncate paths in some environments.
 */
function isPathTraversal(rawPath: string, resolvedPath: string, homePath: string): boolean {
	// Null bytes can truncate paths in some C-level APIs
	if (rawPath.includes('\0')) {
		return true;
	}

	if (!rawPath.includes('..')) {
		return false;
	}

	// Expand tilde in the raw path to get the "intended" starting point
	const expanded = expandTilde(rawPath, homePath);

	// Split on path separator to find actual `..` segments (not substrings like `file..txt`)
	const segments = expanded.split(path.sep);
	const hasTraversalSegment = segments.some((seg) => seg === '..');
	if (!hasTraversalSegment) {
		return false;
	}

	// The resolved path should be a descendant of the raw path's first non-traversal parent
	const firstPart = expanded.split(`${path.sep}..`)[0] ?? expanded;
	const expectedParent = path.dirname(path.resolve(firstPart));
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
	const resolvedWorkspaceReal = (() => {
		try {
			return realpathSync(resolvedWorkspace);
		} catch {
			return resolvedWorkspace;
		}
	})();
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
		if (
			effectivePath === resolvedWorkspaceReal ||
			effectivePath.startsWith(`${resolvedWorkspaceReal}/`)
		) {
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

		const requestedBy = (params.requestedBy as string | undefined) ?? 'agent';

		function resourceLabel(): string {
			if (action === 'move') {
				return `${String(params.sourcePath ?? '')} -> ${String(params.destinationPath ?? '')}`.trim();
			}
			if (action === 'search') {
				return `${String(rawPath ?? '')} pattern=${String(params.pattern ?? '')}`.trim();
			}
			return String(rawPath ?? '');
		}

		if (!rawPath && action !== 'move') {
			const auditEntry = createAuditEntry(
				action,
				resourceLabel(),
				sanitizeParamsForAudit(action, params),
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

		function deny(
			auditResource: string,
			resolvedPath: string | undefined,
			error: string,
			result: AuditEntry['result'] = 'denied',
		): CapabilityResult {
			const auditParams = sanitizeParamsForAudit(action, params);
			if (resolvedPath) {
				auditParams.resolvedPath = resolvedPath;
			}
			return {
				success: false,
				output: null,
				error,
				auditEntry: createAuditEntry(
					action,
					auditResource,
					auditParams,
					'rule-denied',
					result,
					0,
					undefined,
					error,
					requestedBy,
				),
				durationMs: 0,
			};
		}

		function requirePermission(
			permissionAction: string,
			resource: string,
		):
			| { ok: true; executionPath: string; decision: PermissionDecision }
			| { ok: false; result: CapabilityResult } {
			const resolvedPath = resolveFsPath(resource);
			const permRequest: PermissionRequest = {
				capability: 'filesystem',
				action: permissionAction,
				resource,
				requestedBy,
			};
			const decision = checkPermission(permRequest);
			if (!decision.allowed) {
				logger.warn('Filesystem access denied', {
					action: permissionAction,
					path: resolvedPath,
					reason: decision.reason,
				});
				return { ok: false, result: deny(resource, resolvedPath, decision.reason, 'denied') };
			}

			if (decision.level === 'user-approved' && params.__approvedByUser !== true) {
				return {
					ok: false,
					result: deny(resource, resolvedPath, 'Missing explicit user approval token', 'denied'),
				};
			}

			const actionPath = resolveActionPath(resolvedPath, permissionAction);
			if (!actionPath.ok) {
				return {
					ok: false,
					result: {
						success: false,
						output: null,
						error: `Path resolution failed: ${actionPath.reason}`,
						auditEntry: createAuditEntry(
							action,
							resolvedPath,
							sanitizeParamsForAudit(action, params),
							'error',
							'error',
							0,
							undefined,
							`Path resolution failed: ${actionPath.reason}`,
							requestedBy,
						),
						durationMs: 0,
					},
				};
			}

			return { ok: true, executionPath: actionPath.path, decision };
		}

		const start = Date.now();

		try {
			let output: unknown;
			let outputStr: string;
			let auditResource = resourceLabel();
			let auditDecision: AuditEntry['decision'] = 'auto-approved';

			switch (action) {
				case 'read': {
					const perm = requirePermission('read', rawPath ?? '');
					if (!perm.ok) return perm.result;
					const size = statSync(perm.executionPath).size;
					if (size > MAX_READ_BYTES) {
						return deny(
							rawPath ?? '',
							perm.executionPath,
							`File too large to read (${size} bytes, limit ${MAX_READ_BYTES}).`,
							'error',
						);
					}
					const content = readFileSync(perm.executionPath, 'utf-8');
					output = content;
					outputStr = `${String(Buffer.byteLength(content, 'utf-8'))} bytes read`;
					auditResource = rawPath ?? '';
					auditDecision =
						perm.decision.level === 'user-approved' ? 'user-approved' : 'auto-approved';
					break;
				}
				case 'write': {
					const perm = requirePermission('write', rawPath ?? '');
					if (!perm.ok) return perm.result;
					const content = (params.content as string) ?? '';
					writeFileSync(perm.executionPath, content, 'utf-8');
					const bytesWritten = Buffer.byteLength(content, 'utf-8');
					output = { bytesWritten };
					outputStr = `${String(bytesWritten)} bytes written`;
					auditResource = rawPath ?? '';
					auditDecision =
						perm.decision.level === 'user-approved' ? 'user-approved' : 'auto-approved';
					break;
				}
				case 'list': {
					const perm = requirePermission('list', rawPath ?? '');
					if (!perm.ok) return perm.result;
					const entries = readdirSync(perm.executionPath);
					output = entries;
					outputStr = entries.join('\n');
					auditResource = rawPath ?? '';
					auditDecision =
						perm.decision.level === 'user-approved' ? 'user-approved' : 'auto-approved';
					break;
				}
				case 'delete': {
					const perm = requirePermission('delete', rawPath ?? '');
					if (!perm.ok) return perm.result;
					unlinkSync(perm.executionPath);
					output = { deleted: true };
					outputStr = `Deleted ${perm.executionPath}`;
					auditResource = rawPath ?? '';
					auditDecision =
						perm.decision.level === 'user-approved' ? 'user-approved' : 'auto-approved';
					break;
				}
				case 'search': {
					const pattern = params.pattern as string | undefined;
					if (!pattern || typeof pattern !== 'string') {
						return deny(
							rawPath ?? '',
							rawPath ? resolveFsPath(rawPath) : undefined,
							'Missing required parameter: pattern',
							'error',
						);
					}
					const perm = requirePermission('search', rawPath ?? '');
					if (!perm.ok) return perm.result;

					const { matches, truncated } = walkSearch(
						perm.executionPath,
						pattern,
						MAX_SEARCH_RESULTS,
					);
					output = matches;
					outputStr = truncated
						? `${matches.length} match(es) (truncated at ${MAX_SEARCH_RESULTS})`
						: `${matches.length} match(es)`;
					auditResource = `${rawPath ?? ''} pattern=${pattern}`;
					auditDecision =
						perm.decision.level === 'user-approved' ? 'user-approved' : 'auto-approved';
					break;
				}
				case 'move': {
					const sourcePath = params.sourcePath as string | undefined;
					const destinationPath = params.destinationPath as string | undefined;
					if (!sourcePath || !destinationPath) {
						const resource = `${String(sourcePath ?? '')} -> ${String(destinationPath ?? '')}`;
						return deny(
							resource,
							'',
							'Missing required parameters: sourcePath, destinationPath',
							'error',
						);
					}

					const sourcePerm = requirePermission('delete', sourcePath);
					if (!sourcePerm.ok) return sourcePerm.result;
					const destPerm = requirePermission('write', destinationPath);
					if (!destPerm.ok) return destPerm.result;

					renameSync(sourcePerm.executionPath, destPerm.executionPath);
					output = { moved: true };
					outputStr = `Moved ${sourcePerm.executionPath} -> ${destPerm.executionPath}`;
					auditResource = `${sourcePath} -> ${destinationPath}`;
					auditDecision =
						sourcePerm.decision.level === 'user-approved' ||
						destPerm.decision.level === 'user-approved'
							? 'user-approved'
							: 'auto-approved';
					break;
				}
				default: {
					const durationMs = Date.now() - start;
					const auditEntry = createAuditEntry(
						action,
						'',
						sanitizeParamsForAudit(action, params),
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
			const auditEntry = createAuditEntry(
				action,
				auditResource,
				sanitizeParamsForAudit(action, params),
				auditDecision,
				'success',
				durationMs,
				truncateOutput(outputStr, AUDIT_OUTPUT_MAX_BYTES),
				undefined,
				requestedBy,
			);

			logger.debug('Filesystem action executed', {
				action,
				path: rawPath,
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
				path: rawPath,
				error: errorMessage,
			});

			const auditEntry = createAuditEntry(
				action,
				String(rawPath ?? ''),
				sanitizeParamsForAudit(action, params),
				'error',
				'error',
				durationMs,
				undefined,
				errorMessage,
				requestedBy,
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
