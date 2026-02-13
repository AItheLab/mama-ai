import { execFile } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import type {
	AuditEntry,
	Capability,
	CapabilityResult,
	PermissionDecision,
	PermissionRequest,
} from './types.js';

const logger = createLogger('sandbox:shell');

export interface ShellSandboxConfig {
	safeCommands: string[];
	askCommands: string[];
	deniedPatterns: string[];
}

type SegmentClassification = 'safe' | 'ask' | 'denied' | 'unknown';

const SHELL_EXPANSION_PATTERN = /`|\$\(|\$\{|<\(|>\(|\n/;
const SHELL_REDIRECTION_PATTERN = /(^|\s)(?:>|>>|<|<<|1>|1>>|2>|2>>|&>)/;

/**
 * Splits a compound command string into individual segments by
 * pipe (|), semicolon (;), and logical operators (&& and ||).
 */
export function parseCommand(command: string): string[] {
	// Split on |, ;, &&, || — keeping the delimiters out
	const segments = command.split(/\s*(?:\|\||&&|[|;])\s*/);
	return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Classifies a single command segment against the sandbox config.
 *
 * Priority: denied > safe > ask > unknown
 */
export function classifySegment(
	segment: string,
	config: ShellSandboxConfig,
): SegmentClassification {
	const trimmed = segment.trim();
	const lowered = trimmed.toLowerCase();

	// Check denied patterns first — substring match
	for (const pattern of config.deniedPatterns) {
		if (lowered.includes(pattern.toLowerCase())) {
			return 'denied';
		}
	}

	// Shell expansions and redirections are never auto-approved.
	// They can introduce side effects or hidden command execution.
	if (SHELL_EXPANSION_PATTERN.test(trimmed) || SHELL_REDIRECTION_PATTERN.test(trimmed)) {
		return 'ask';
	}

	// Extract the command base (first word, or first two words for compound commands like "git status")
	const words = trimmed.split(/\s+/);

	// Check safe commands — match against command base
	for (const safe of config.safeCommands) {
		const safeWords = safe.split(/\s+/);
		if (safeWords.length <= words.length) {
			const baseSlice = words.slice(0, safeWords.length).join(' ');
			if (baseSlice === safe) {
				return 'safe';
			}
		}
	}

	// Check ask commands — match against command base
	for (const ask of config.askCommands) {
		const askWords = ask.split(/\s+/);
		if (askWords.length <= words.length) {
			const baseSlice = words.slice(0, askWords.length).join(' ');
			if (baseSlice === ask) {
				return 'ask';
			}
		}
	}

	return 'unknown';
}

interface ShellExecOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const MAX_AUDIT_OUTPUT_LENGTH = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Creates a Shell capability for the sandbox.
 *
 * Commands are classified into safe (auto-approved), ask (user-approved),
 * denied (blocked), or unknown (treated as ask). Compound commands
 * (pipes, chains) are split and each segment is classified independently;
 * the most restrictive classification wins.
 */
export function createShellCapability(config: ShellSandboxConfig): Capability {
	function checkPermission(request: PermissionRequest): PermissionDecision {
		const command = request.resource;
		const segments = parseCommand(command);

		if (segments.length === 0) {
			return { allowed: false, reason: 'Empty command', level: 'denied' };
		}

		let needsApproval = false;

		// Compound commands are never auto-approved.
		if (segments.length > 1) {
			needsApproval = true;
		}

		for (const segment of segments) {
			const classification = classifySegment(segment, config);

			if (classification === 'denied') {
				logger.warn('Shell command denied', {
					command,
					segment,
					requestedBy: request.requestedBy,
				});
				return {
					allowed: false,
					reason: `Command segment denied: "${segment}"`,
					level: 'denied',
				};
			}

			if (classification === 'ask' || classification === 'unknown') {
				needsApproval = true;
			}
		}

		if (needsApproval) {
			return { allowed: true, level: 'user-approved' };
		}

		return { allowed: true, level: 'auto' };
	}

	async function execute(
		action: string,
		params: Record<string, unknown>,
	): Promise<CapabilityResult> {
		const command = params.command as string | undefined;
		const cwd = params.cwd as string | undefined;
		const timeout = (params.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;

		if (!command || typeof command !== 'string') {
			const entry = createErrorAuditEntry(
				action,
				command ?? '',
				'Missing or invalid command parameter',
			);
			return {
				success: false,
				output: null,
				error: 'Missing or invalid command parameter',
				auditEntry: entry,
				durationMs: 0,
			};
		}

		// Check permission before executing
		const request: PermissionRequest = {
			capability: 'shell',
			action,
			resource: command,
			requestedBy: (params.requestedBy as string | undefined) ?? 'agent',
		};
		const decision = checkPermission(request);

		if (!decision.allowed) {
			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'shell',
				action,
				resource: command,
				params: { command, cwd, timeout },
				decision: 'rule-denied',
				result: 'denied',
				error: decision.reason,
				durationMs: 0,
				requestedBy: request.requestedBy,
			};

			logger.warn('Shell execution denied', { command, reason: decision.reason });

			return {
				success: false,
				output: null,
				error: decision.reason,
				auditEntry: entry,
				durationMs: 0,
			};
		}

		if (decision.level === 'user-approved' && params.__approvedByUser !== true) {
			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'shell',
				action,
				resource: command,
				params: { command, cwd, timeout },
				decision: 'rule-denied',
				result: 'denied',
				error: 'Missing explicit user approval token',
				durationMs: 0,
				requestedBy: request.requestedBy,
			};

			logger.warn('Shell execution blocked: missing approval token', { command });

			return {
				success: false,
				output: null,
				error: 'Missing explicit user approval token',
				auditEntry: entry,
				durationMs: 0,
			};
		}

		const startTime = Date.now();

		try {
			const result = await executeShellCommand(command, { cwd, timeout });
			const durationMs = Date.now() - startTime;

			const outputStr = formatOutput(result);
			const truncatedOutput = outputStr.slice(0, MAX_AUDIT_OUTPUT_LENGTH);

			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'shell',
				action,
				resource: command,
				params: { command, cwd, timeout },
				decision: decision.level === 'auto' ? 'auto-approved' : 'user-approved',
				result: result.exitCode === 0 ? 'success' : 'error',
				output: truncatedOutput,
				error: result.exitCode !== 0 ? result.stderr.slice(0, MAX_AUDIT_OUTPUT_LENGTH) : undefined,
				durationMs,
				requestedBy: request.requestedBy,
			};

			logger.info('Shell command executed', {
				command,
				exitCode: result.exitCode,
				durationMs,
			});

			return {
				success: result.exitCode === 0,
				output: {
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				},
				error: result.exitCode !== 0 ? result.stderr : undefined,
				auditEntry: entry,
				durationMs,
			};
		} catch (err: unknown) {
			const durationMs = Date.now() - startTime;
			const errorMessage = err instanceof Error ? err.message : String(err);

			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'shell',
				action,
				resource: command,
				params: { command, cwd, timeout },
				decision: decision.level === 'auto' ? 'auto-approved' : 'user-approved',
				result: 'error',
				error: errorMessage.slice(0, MAX_AUDIT_OUTPUT_LENGTH),
				durationMs,
				requestedBy: request.requestedBy,
			};

			logger.error('Shell command failed', { command, error: errorMessage, durationMs });

			return {
				success: false,
				output: null,
				error: errorMessage,
				auditEntry: entry,
				durationMs,
			};
		}
	}

	return {
		name: 'shell',
		description: 'Execute shell commands with safety classification',
		checkPermission,
		execute,
	};
}

function executeShellCommand(
	command: string,
	options: { cwd?: string; timeout: number },
): Promise<ShellExecOutput> {
	return new Promise((resolve, reject) => {
		execFile(
			'/bin/sh',
			['-c', command],
			{
				timeout: options.timeout,
				maxBuffer: MAX_BUFFER_BYTES,
				cwd: options.cwd,
			},
			(error, stdout, stderr) => {
				if (error && !('code' in error)) {
					// Process-level error (e.g. timeout, spawn failure)
					reject(error);
					return;
				}

				// Normal completion — exitCode may be non-zero
				const exitCode = error && 'code' in error ? (error.code as number) : 0;
				resolve({
					stdout: String(stdout),
					stderr: String(stderr),
					exitCode,
				});
			},
		);
	});
}

function formatOutput(result: ShellExecOutput): string {
	const parts: string[] = [];
	if (result.stdout) {
		parts.push(`stdout: ${result.stdout}`);
	}
	if (result.stderr) {
		parts.push(`stderr: ${result.stderr}`);
	}
	parts.push(`exitCode: ${result.exitCode}`);
	return parts.join('\n');
}

function createErrorAuditEntry(action: string, resource: string, error: string): AuditEntry {
	return {
		id: uuidv4(),
		timestamp: new Date(),
		capability: 'shell',
		action,
		resource,
		decision: 'error',
		result: 'error',
		error,
		durationMs: 0,
		requestedBy: 'agent',
	};
}
