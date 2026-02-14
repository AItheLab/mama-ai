const REDACTED_VALUE = '[REDACTED]';

const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)([A-Za-z0-9\-._~+/]+=*)\b/gi;
const PRIVATE_KEY_BLOCK_PATTERN =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const GENERIC_SECRET_FIELD_NAME =
	'[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN|AUTHORIZATION|CREDENTIALS?)';
const SECRET_ENV_ASSIGNMENT_PATTERN = new RegExp(
	`\\b(${GENERIC_SECRET_FIELD_NAME})\\s*=\\s*("([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*'|[^\\s]+)`,
	'gi',
);
const SECRET_FIELD_PATTERN = new RegExp(
	`("?(?:${GENERIC_SECRET_FIELD_NAME})"?)\\s*:\\s*("([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*'|[^\\s,}\\]]+)`,
	'gi',
);
const KNOWN_SECRET_PREFIX_PATTERNS = [
	/\bsk-[A-Za-z0-9]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

export function redactSecrets(text: string): string {
	let redacted = text;

	redacted = redacted.replace(
		PRIVATE_KEY_BLOCK_PATTERN,
		'-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----',
	);
	redacted = redacted.replace(SECRET_ENV_ASSIGNMENT_PATTERN, (_match, key: string) => {
		return `${key}=${REDACTED_VALUE}`;
	});
	redacted = redacted.replace(SECRET_FIELD_PATTERN, (_match, key: string) => {
		return `${key}: "${REDACTED_VALUE}"`;
	});
	redacted = redacted.replace(BEARER_TOKEN_PATTERN, (_match, prefix: string) => {
		return `${prefix}${REDACTED_VALUE}`;
	});
	redacted = redacted.replace(TELEGRAM_BOT_TOKEN_PATTERN, REDACTED_VALUE);

	for (const pattern of KNOWN_SECRET_PREFIX_PATTERNS) {
		redacted = redacted.replace(pattern, REDACTED_VALUE);
	}

	return redacted;
}

export function redactSecretsInValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return redactSecrets(value);
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactSecretsInValue(item));
	}

	if (!value || typeof value !== 'object') {
		return value;
	}

	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		return value;
	}

	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	for (const [key, item] of Object.entries(source)) {
		result[key] = redactSecretsInValue(item);
	}

	return result;
}
