import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../memory/store.js';
import { createSkillLoader } from '../loader.js';
import { createSkillRegistry } from '../registry.js';

const tempRoots: string[] = [];

function createTempDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function checksum(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function writeSkill(root: string, name: string): string {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	const manifest = [
		`name: ${name}`,
		'version: "1.0.0"',
		'capabilities:',
		'  - type: notes',
		'    actions: ["create", "list"]',
	].join('\n');
	writeFileSync(join(skillDir, 'manifest.yaml'), manifest, 'utf-8');
	writeFileSync(join(skillDir, 'manifest.sha256'), checksum(manifest), 'utf-8');
	return skillDir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe('createSkillRegistry', () => {
	it('installs, lists, enables/disables, and uninstalls skills', async () => {
		const dbPath = join(createTempDir('mama-skill-registry-db-'), 'mama.db');
		const skillsRoot = createTempDir('mama-skill-registry-skills-');
		const skillPath = writeSkill(skillsRoot, 'notes-pro');

		const store = createMemoryStore({ dbPath });
		const loader = createSkillLoader({ skillsDir: skillsRoot });
		const registry = createSkillRegistry({ store, loader });

		await registry.install(skillPath);
		let installed = registry.list();
		expect(installed).toHaveLength(1);
		expect(installed[0]?.name).toBe('notes-pro');
		expect(installed[0]?.enabled).toBe(true);

		await registry.disable('notes-pro');
		installed = registry.list();
		expect(installed[0]?.enabled).toBe(false);

		await registry.enable('notes-pro');
		installed = registry.list();
		expect(installed[0]?.enabled).toBe(true);

		await registry.uninstall('notes-pro');
		expect(registry.list()).toHaveLength(0);

		store.close();
	});

	it('installs built-in skills bundle', async () => {
		const dbPath = join(createTempDir('mama-skill-registry-db-'), 'mama.db');
		const store = createMemoryStore({ dbPath });
		const registry = createSkillRegistry({ store });

		await registry.installBuiltIns();
		const names = registry.list().map((skill) => skill.name);
		expect(names).toEqual(
			expect.arrayContaining(['filesystem', 'git-manager', 'notes', 'system-monitor']),
		);

		store.close();
	});
});
