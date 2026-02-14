import { describe, expect, it } from 'vitest';
import { redactSecrets, redactSecretsInValue } from '../secret-redaction.js';

describe('secret-redaction', () => {
	it('redacts env-style secret assignments', () => {
		const input = 'MAMA_TELEGRAM_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567';
		const output = redactSecrets(input);

		expect(output).toBe('MAMA_TELEGRAM_TOKEN=[REDACTED]');
	});

	it('redacts bearer tokens and private key blocks', () => {
		const input = [
			'Authorization: Bearer super-secret-value',
			'-----BEGIN PRIVATE KEY-----',
			'abc123',
			'-----END PRIVATE KEY-----',
		].join('\n');
		const output = redactSecrets(input);

		expect(output).toContain('Authorization: Bearer [REDACTED]');
		expect(output).toContain('-----BEGIN PRIVATE KEY-----');
		expect(output).toContain('[REDACTED]');
		expect(output).not.toContain('abc123');
		expect(output).not.toContain('super-secret-value');
	});

	it('redacts nested string values recursively', () => {
		const input = {
			command: 'echo MAMA_API_TOKEN=top-secret',
			nested: {
				header: 'Bearer abc',
			},
			list: ['keep-me', 'TELEGRAM_TOKEN=xyz'],
		};
		const output = redactSecretsInValue(input) as {
			command: string;
			nested: { header: string };
			list: string[];
		};

		expect(output.command).toBe('echo MAMA_API_TOKEN=[REDACTED]');
		expect(output.nested.header).toBe('Bearer [REDACTED]');
		expect(output.list[0]).toBe('keep-me');
		expect(output.list[1]).toBe('TELEGRAM_TOKEN=[REDACTED]');
	});
});
