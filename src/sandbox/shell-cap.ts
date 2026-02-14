import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import { redactSecrets } from '../utils/secret-redaction.js';
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
const SEGMENT_OPERATORS = new Set(['|', '||', '&&', ';']);
const TOKEN_OPERATORS = new Set([
	'|',
	'||',
	'&&',
	';',
	'>',
	'>>',
	'<',
	'<<',
	'1>',
	'1>>',
	'2>',
	'2>>',
	'&>',
]);

function tokenizeShell(input: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let inSingle = false;
	let inDouble = false;
	let escaping = false;

	const flush = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = '';
		}
	};

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (char === undefined) continue;

		if (inSingle) {
			if (char === "'") {
				inSingle = false;
				continue;
			}
			current += char;
			continue;
		}

		if (inDouble) {
			if (escaping) {
				current += char;
				escaping = false;
				continue;
			}
			if (char === '\\') {
				escaping = true;
				continue;
			}
			if (char === '"') {
				inDouble = false;
				continue;
			}
			current += char;
			continue;
		}

		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === '\\') {
			escaping = true;
			continue;
		}
		if (char === "'") {
			inSingle = true;
			continue;
		}
		if (char === '"') {
			inDouble = true;
			continue;
		}
		if (/\s/.test(char)) {
			flush();
			continue;
		}

		const rest = input.slice(i);
		const operatorMatch = rest.match(/^(?:\|\||&&|1>>|1>|2>>|2>|>>|<<|&>|[|;&<>])/);
		if (operatorMatch?.[0]) {
			flush();
			tokens.push(operatorMatch[0]);
			i += operatorMatch[0].length - 1;
			continue;
		}

		current += char;
	}

	if (escaping) {
		current += '\\';
	}
	flush();

	return tokens;
}

function normalizeTokens(tokens: string[]): string[] {
	return tokens.map((token) => token.toLowerCase());
}

function isOperatorToken(token: string): boolean {
	return TOKEN_OPERATORS.has(token);
}

function tokenMatchesPatternToken(token: string, patternToken: string): boolean {
	if (patternToken.endsWith('=')) {
		return token.startsWith(patternToken);
	}
	if (patternToken.startsWith('/')) {
		return token.startsWith(patternToken);
	}
	return token === patternToken;
}

function matchesPatternInTokens(tokens: string[], patternTokens: string[]): boolean {
	if (patternTokens.length === 0 || tokens.length < patternTokens.length) {
		return false;
	}

	for (let start = 0; start <= tokens.length - patternTokens.length; start++) {
		let matched = true;
		for (let offset = 0; offset < patternTokens.length; offset++) {
			const token = tokens[start + offset];
			const patternToken = patternTokens[offset];
			if (!token || !patternToken || !tokenMatchesPatternToken(token, patternToken)) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return true;
		}
	}

	return false;
}

function matchesDeniedPattern(tokens: string[], deniedPatterns: string[]): string | null {
	for (const pattern of deniedPatterns) {
		const normalizedPatternTokens = normalizeTokens(tokenizeShell(pattern)).filter(
			(token) => token.length > 0,
		);
		if (normalizedPatternTokens.length === 0) continue;
		if (matchesPatternInTokens(tokens, normalizedPatternTokens)) {
			return pattern;
		}
	}
	return null;
}

/**
 * Splits a compound command string into individual segments by
 * pipe (|), semicolon (;), and logical operators (&& and ||).
 */
export function parseCommand(command: string): string[] {
	const tokens = tokenizeShell(command);
	const segments: string[] = [];
	let current: string[] = [];

	const flush = () => {
		if (current.length === 0) return;
		const segment = current.join(' ').trim();
		if (segment.length > 0) {
			segments.push(segment);
		}
		current = [];
	};

	for (const token of tokens) {
		if (SEGMENT_OPERATORS.has(token)) {
			flush();
			continue;
		}
		current.push(token);
	}

	flush();
	return segments;
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
	if (trimmed.length === 0) {
		return 'unknown';
	}

	const normalizedTokens = normalizeTokens(tokenizeShell(trimmed));
	const matchedDeniedPattern = matchesDeniedPattern(normalizedTokens, config.deniedPatterns);
	if (matchedDeniedPattern) {
		return 'denied';
	}

	// Shell expansions and redirections are never auto-approved.
	// They can introduce side effects or hidden command execution.
	if (SHELL_EXPANSION_PATTERN.test(trimmed) || SHELL_REDIRECTION_PATTERN.test(trimmed)) {
		return 'ask';
	}

	const words = normalizedTokens.filter((token) => token.length > 0 && !isOperatorToken(token));
	if (words.length === 0) {
		return 'unknown';
	}

	// Check safe commands — match against command base
	for (const safe of config.safeCommands) {
		const safeWords = normalizeTokens(tokenizeShell(safe)).filter(
			(token) => !isOperatorToken(token),
		);
		if (safeWords.length > words.length || safeWords.length === 0) continue;
		const matches = safeWords.every((safeWord, idx) => words[idx] === safeWord);
		if (matches) {
			return 'safe';
		}
	}

	// Check ask commands — match against command base
	for (const ask of config.askCommands) {
		const askWords = normalizeTokens(tokenizeShell(ask)).filter((token) => !isOperatorToken(token));
		if (askWords.length > words.length || askWords.length === 0) continue;
		const matches = askWords.every((askWord, idx) => words[idx] === askWord);
		if (matches) {
			return 'ask';
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
		const redactedCommand = redactSecrets(command);
		const segments = parseCommand(command);
		const normalizedTokens = normalizeTokens(tokenizeShell(command));

		if (segments.length === 0) {
			return { allowed: false, reason: 'Empty command', level: 'denied' };
		}

		const matchedDeniedPattern = matchesDeniedPattern(normalizedTokens, config.deniedPatterns);
		if (matchedDeniedPattern) {
			logger.warn('Shell command denied by global pattern', {
				command: redactedCommand,
				pattern: matchedDeniedPattern,
				requestedBy: request.requestedBy,
			});
			return {
				allowed: false,
				reason: `Command denied by policy pattern: "${matchedDeniedPattern}"`,
				level: 'denied',
			};
		}

		let needsApproval = false;

		// Compound commands are never auto-approved.
		if (segments.length > 1) {
			needsApproval = true;
		}

		for (const segment of segments) {
			const classification = classifySegment(segment, config);

			if (classification === 'denied') {
				const redactedSegment = redactSecrets(segment);
				logger.warn('Shell command denied', {
					command: redactedCommand,
					segment: redactedSegment,
					requestedBy: request.requestedBy,
				});
				return {
					allowed: false,
					reason: `Command segment denied: "${redactedSegment}"`,
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
		const redactedCommand = redactSecrets(command ?? '');

		if (!command || typeof command !== 'string') {
			const entry = createErrorAuditEntry(
				action,
				redactedCommand,
				'Missing or invalid command parameter',
			);
			return {
				success: false,
				output: null,
				error: redactSecrets('Missing or invalid command parameter'),
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
			const redactedDecisionReason = redactSecrets(decision.reason);
			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'shell',
				action,
				resource: redactedCommand,
				params: { command: redactedCommand, cwd, timeout },
				decision: 'rule-denied',
				result: 'denied',
				error: redactedDecisionReason,
				durationMs: 0,
				requestedBy: request.requestedBy,
			};

			logger.warn('Shell execution denied', {
				command: redactedCommand,
				reason: redactedDecisionReason,
			});

			return {
				success: false,
				output: null,
				error: redactedDecisionReason,
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
				resource: redactedCommand,
				params: { command: redactedCommand, cwd, timeout },
				decision: 'rule-denied',
				result: 'denied',
				error: 'Missing explicit user approval token',
				durationMs: 0,
				requestedBy: request.requestedBy,
			};

			logger.warn('Shell execution blocked: missing approval token', { command: redactedCommand });

			return {
				success: false,
				output: null,
				error: 'Missing explicit user approval token',
				auditEntry: entry,
				durationMs: 0,
			};
		}

		// Validate and resolve cwd to prevent symlink-based escapes
		let resolvedCwd: string | undefined;
		if (cwd) {
			try {
				const absoluteCwd = resolvePath(cwd);
				if (!existsSync(absoluteCwd) || !statSync(absoluteCwd).isDirectory()) {
					const entry = createErrorAuditEntry(action, redactedCommand, `Invalid cwd: not a directory`);
					return { success: false, output: null, error: 'Invalid cwd: not a directory', auditEntry: entry, durationMs: 0 };
				}
				resolvedCwd = realpathSync(absoluteCwd);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : 'Failed to resolve cwd';
				const entry = createErrorAuditEntry(action, redactedCommand, msg);
				return { success: false, output: null, error: msg, auditEntry: entry, durationMs: 0 };
			}
		}

		const startTime = Date.now();

		try {
			const result = await executeShellCommand(command, { cwd: resolvedCwd, timeout });
			const redactedResult = {
				stdout: redactSecrets(result.stdout),
				stderr: redactSecrets(result.stderr),
				exitCode: result.exitCode,
			} satisfies ShellExecOutput;
			const durationMs = Date.now() - startTime;

			const outputStr = formatOutput(redactedResult);
			const truncatedOutput = outputStr.slice(0, MAX_AUDIT_OUTPUT_LENGTH);

			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'shell',
				action,
				resource: redactedCommand,
				params: { command: redactedCommand, cwd, timeout },
				decision: decision.level === 'auto' ? 'auto-approved' : 'user-approved',
				result: redactedResult.exitCode === 0 ? 'success' : 'error',
				output: truncatedOutput,
				error:
					redactedResult.exitCode !== 0
						? redactedResult.stderr.slice(0, MAX_AUDIT_OUTPUT_LENGTH)
						: undefined,
				durationMs,
				requestedBy: request.requestedBy,
			};

			logger.info('Shell command executed', {
				command: redactedCommand,
				exitCode: redactedResult.exitCode,
				durationMs,
			});

			return {
				success: redactedResult.exitCode === 0,
				output: {
					stdout: redactedResult.stdout,
					stderr: redactedResult.stderr,
					exitCode: redactedResult.exitCode,
				},
				error: redactedResult.exitCode !== 0 ? redactedResult.stderr : undefined,
				auditEntry: entry,
				durationMs,
			};
		} catch (err: unknown) {
			const durationMs = Date.now() - startTime;
			const errorMessage = redactSecrets(err instanceof Error ? err.message : String(err));

			const entry: AuditEntry = {
				id: uuidv4(),
				timestamp: new Date(),
				capability: 'shell',
				action,
				resource: redactedCommand,
				params: { command: redactedCommand, cwd, timeout },
				decision: decision.level === 'auto' ? 'auto-approved' : 'user-approved',
				result: 'error',
				error: errorMessage.slice(0, MAX_AUDIT_OUTPUT_LENGTH),
				durationMs,
				requestedBy: request.requestedBy,
			};

			logger.error('Shell command failed', {
				command: redactedCommand,
				error: errorMessage,
				durationMs,
			});

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
