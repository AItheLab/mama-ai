import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryStore } from '../memory/store.js';
import { createLogger } from '../utils/logger.js';
import { createSkillLoader, type SkillLoader } from './loader.js';
import type { InstalledSkill, LoadedSkill, SkillManifest } from './types.js';

const logger = createLogger('skills:registry');

interface CreateSkillRegistryOptions {
	store: MemoryStore;
	loader?: SkillLoader;
}

interface SkillRegistry {
	install(path: string): Promise<void>;
	uninstall(name: string): Promise<void>;
	list(): InstalledSkill[];
	enable(name: string): Promise<void>;
	disable(name: string): Promise<void>;
	installBuiltIns(): Promise<void>;
}

interface SkillRow {
	name: string;
	version: string;
	installed_at: string;
	manifest: string;
	enabled: number | boolean;
	checksum: string;
}

function parseManifest(value: string): SkillManifest {
	return JSON.parse(value) as SkillManifest;
}

function toInstalledSkill(row: SkillRow): InstalledSkill {
	return {
		name: row.name,
		version: row.version,
		installedAt: new Date(row.installed_at),
		enabled: Boolean(row.enabled),
		checksum: row.checksum,
		manifest: parseManifest(row.manifest),
	};
}

function upsertSkill(store: MemoryStore, skill: LoadedSkill): void {
	store.run(
		`INSERT INTO skills (name, version, installed_at, manifest, enabled, checksum)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
		   version = excluded.version,
		   installed_at = excluded.installed_at,
		   manifest = excluded.manifest,
		   enabled = excluded.enabled,
		   checksum = excluded.checksum`,
		[
			skill.name,
			skill.version,
			new Date().toISOString(),
			JSON.stringify(skill.manifest),
			skill.enabled ? 1 : 0,
			skill.checksum,
		],
	);
}

export function createSkillRegistry(options: CreateSkillRegistryOptions): SkillRegistry {
	const loader = options.loader ?? createSkillLoader();

	async function install(path: string): Promise<void> {
		const skill = await loader.loadSkill(path);
		upsertSkill(options.store, skill);
		logger.info('Skill installed', { name: skill.name, version: skill.version });
	}

	async function uninstall(name: string): Promise<void> {
		options.store.run('DELETE FROM skills WHERE name = ?', [name]);
	}

	function list(): InstalledSkill[] {
		const rows = options.store.all<SkillRow>(
			`SELECT name, version, installed_at, manifest, enabled, checksum
			 FROM skills
			 ORDER BY name ASC`,
		);
		return rows.map(toInstalledSkill);
	}

	async function enable(name: string): Promise<void> {
		options.store.run('UPDATE skills SET enabled = 1 WHERE name = ?', [name]);
	}

	async function disable(name: string): Promise<void> {
		options.store.run('UPDATE skills SET enabled = 0 WHERE name = ?', [name]);
	}

	async function installBuiltIns(): Promise<void> {
		const builtInRoot = join(dirname(fileURLToPath(import.meta.url)), 'built-in');
		const builtInLoader = createSkillLoader({ skillsDir: builtInRoot });
		const builtIns = await builtInLoader.loadAll();
		for (const skill of builtIns) {
			upsertSkill(options.store, skill);
		}
	}

	return {
		install,
		uninstall,
		list,
		enable,
		disable,
		installBuiltIns,
	};
}

export type { SkillRegistry, CreateSkillRegistryOptions };
