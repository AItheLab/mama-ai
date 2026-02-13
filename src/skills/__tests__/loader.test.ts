import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillLoader } from '../loader.js';

const tempRoots: string[] = [];

function createTempDir(): string {
	const root = mkdtempSync(join(tmpdir(), 'mama-skill-loader-test-'));
	tempRoots.push(root);
	return root;
}

function checksum(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe('createSkillLoader', () => {
	it('loads skills from directory and validates checksum', async () => {
		const root = createTempDir();
		const skillDir = join(root, 'sample');
		mkdirSync(skillDir, { recursive: true });
		const manifest = [
			'name: sample',
			'version: "1.0.0"',
			'capabilities:',
			'  - type: filesystem',
			'    actions: ["read", "write"]',
		].join('\n');
		writeFileSync(join(skillDir, 'manifest.yaml'), manifest, { encoding: 'utf-8', flag: 'w' });
		writeFileSync(join(skillDir, 'manifest.sha256'), checksum(manifest), 'utf-8');

		const loader = createSkillLoader({ skillsDir: root });
		const skills = await loader.loadAll();
		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe('sample');
		expect(skills[0]?.capabilities[0]?.isActionAllowed('read')).toBe(true);
		expect(skills[0]?.capabilities[0]?.isActionAllowed('delete')).toBe(false);
	});

	it('rejects skills with checksum mismatch', async () => {
		const root = createTempDir();
		const skillDir = join(root, 'bad-skill');
		mkdirSync(skillDir, { recursive: true });
		const manifest = [
			'name: bad-skill',
			'version: "1.0.0"',
			'capabilities:',
			'  - type: shell',
			'    actions: ["status"]',
		].join('\n');
		writeFileSync(join(skillDir, 'manifest.yaml'), manifest, { encoding: 'utf-8', flag: 'w' });
		writeFileSync(join(skillDir, 'manifest.sha256'), 'invalid-checksum', 'utf-8');

		const loader = createSkillLoader({ skillsDir: root });
		await expect(loader.loadSkill(skillDir)).rejects.toThrow('Checksum mismatch');
	});
});
