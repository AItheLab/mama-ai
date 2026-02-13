export type SkillCapabilityType = 'filesystem' | 'shell' | 'network' | 'notes' | 'system-monitor';

export interface SkillCapabilityManifest {
	type: SkillCapabilityType;
	actions: string[];
	allowPaths?: string[];
	denyPatterns?: string[];
}

export interface SkillToolManifest {
	name: string;
	description: string;
}

export interface SkillManifest {
	name: string;
	version: string;
	description?: string;
	checksum?: string;
	capabilities: SkillCapabilityManifest[];
	tools?: SkillToolManifest[];
}

export interface SkillCapabilityInstance {
	skillName: string;
	type: SkillCapabilityType;
	actions: Set<string>;
	allowPaths: string[];
	denyPatterns: string[];
	isActionAllowed(action: string, resource?: string): boolean;
}

export interface LoadedSkill {
	name: string;
	version: string;
	path: string;
	checksum: string;
	manifest: SkillManifest;
	capabilities: SkillCapabilityInstance[];
	tools: SkillToolManifest[];
	enabled: boolean;
}

export interface InstalledSkill {
	name: string;
	version: string;
	installedAt: Date;
	enabled: boolean;
	checksum: string;
	manifest: SkillManifest;
}
