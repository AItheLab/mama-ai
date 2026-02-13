import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getMamaHome } from '../config/defaults.js';
import { createLogger } from '../utils/logger.js';
import type {
	LoadedSkill,
	SkillCapabilityInstance,
	SkillCapabilityManifest,
	SkillManifest,
	SkillToolManifest,
} from './types.js';

const logger = createLogger('skills:loader');

const SkillCapabilitySchema = z.object({
	type: z.enum(['filesystem', 'shell', 'network', 'notes', 'system-monitor']),
	actions: z.array(z.string().min(1)).min(1),
	allowPaths: z.array(z.string()).optional(),
	denyPatterns: z.array(z.string()).optional(),
});

const SkillToolSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
});

const SkillManifestSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	description: z.string().optional(),
	checksum: z.string().optional(),
	capabilities: z.array(SkillCapabilitySchema).min(1),
	tools: z.array(SkillToolSchema).optional(),
});

interface CreateSkillLoaderOptions {
	skillsDir?: string;
}

interface SkillLoader {
	getSkillsDir(): string;
	loadSkill(skillDir: string): Promise<LoadedSkill>;
	loadAll(): Promise<LoadedSkill[]>;
}

function defaultSkillsDir(): string {
	return join(getMamaHome(), 'skills');
}

function computeChecksum(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function readExpectedChecksum(skillDir: string, manifest: SkillManifest): string {
	const filePath = join(skillDir, 'manifest.sha256');
	if (existsSync(filePath)) {
		const raw = readFileSync(filePath, 'utf-8').trim();
		return raw.split(/\s+/)[0] ?? raw;
	}
	if (manifest.checksum) return manifest.checksum;
	throw new Error(
		`Missing checksum for skill at ${skillDir}. Add manifest.sha256 or checksum in manifest.`,
	);
}

function makeCapability(
	skillName: string,
	manifest: SkillCapabilityManifest,
): SkillCapabilityInstance {
	return {
		skillName,
		type: manifest.type,
		actions: new Set(manifest.actions),
		allowPaths: manifest.allowPaths ?? [],
		denyPatterns: manifest.denyPatterns ?? [],
		isActionAllowed(action: string, resource = ''): boolean {
			if (!this.actions.has(action)) return false;
			const normalizedResource = resource.toLowerCase();
			if (this.denyPatterns.some((pattern) => normalizedResource.includes(pattern.toLowerCase()))) {
				return false;
			}
			if (this.allowPaths.length === 0) return true;
			return this.allowPaths.some((allowPath) => resource.startsWith(allowPath));
		},
	};
}

function validateManifest(raw: unknown, skillDir: string): SkillManifest {
	const parsed = SkillManifestSchema.safeParse(raw);
	if (!parsed.success) {
		const message = parsed.error.issues
			.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('; ');
		throw new Error(`Invalid skill manifest at ${skillDir}: ${message}`);
	}
	return parsed.data;
}

function buildTools(manifest: SkillManifest): SkillToolManifest[] {
	if (manifest.tools && manifest.tools.length > 0) {
		return manifest.tools;
	}
	return manifest.capabilities.map((capability, index) => ({
		name: `${manifest.name}_${capability.type}_${index + 1}`,
		description: `${manifest.name} ${capability.type} capability`,
	}));
}

export function createSkillLoader(options: CreateSkillLoaderOptions = {}): SkillLoader {
	const skillsDir = options.skillsDir ?? defaultSkillsDir();

	async function loadSkill(skillDir: string): Promise<LoadedSkill> {
		const manifestPath = join(skillDir, 'manifest.yaml');
		if (!existsSync(manifestPath)) {
			throw new Error(`Skill manifest not found: ${manifestPath}`);
		}
		const manifestRaw = readFileSync(manifestPath, 'utf-8');
		const manifest = validateManifest(parseYaml(manifestRaw), skillDir);
		const checksum = computeChecksum(manifestRaw);
		const expectedChecksum = readExpectedChecksum(skillDir, manifest);
		if (checksum !== expectedChecksum) {
			throw new Error(`Checksum mismatch for skill "${manifest.name}"`);
		}

		const capabilities = manifest.capabilities.map((capability) =>
			makeCapability(manifest.name, capability),
		);
		const tools = buildTools(manifest);

		return {
			name: manifest.name,
			version: manifest.version,
			path: skillDir,
			checksum,
			manifest,
			capabilities,
			tools,
			enabled: true,
		};
	}

	async function loadAll(): Promise<LoadedSkill[]> {
		if (!existsSync(skillsDir)) return [];
		const dirs = readdirSync(skillsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(skillsDir, entry.name));

		const loaded: LoadedSkill[] = [];
		for (const dir of dirs) {
			try {
				loaded.push(await loadSkill(dir));
			} catch (error) {
				logger.warn('Failed to load skill', {
					dir,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return loaded;
	}

	return {
		getSkillsDir: () => skillsDir,
		loadSkill,
		loadAll,
	};
}

export type { SkillLoader, CreateSkillLoaderOptions };
