# Skills System — Extensible & Secure

## Overview

Skills are self-contained modules that extend Mama's capabilities beyond the core tools. Each skill declares exactly what permissions it needs, and Mama enforces those boundaries at runtime.

---

## Skill Structure

```
skills/
└── git-manager/
    ├── manifest.yaml        # Permissions, metadata
    ├── index.ts             # Entry point
    ├── tools.ts             # Tool definitions
    └── README.md            # Description for the user
```

### Manifest (manifest.yaml)

```yaml
name: "git-manager"
version: "1.0.0"
description: "Manage git repositories — status, log, diff, branch operations"
author: "mama-built-in"

# What this skill needs to function
capabilities:
  - type: "shell"
    commands:
      - "git status"
      - "git log"
      - "git diff"
      - "git branch"
      - "git stash"
    level: "auto"            # These are safe, auto-approve
  - type: "shell"
    commands:
      - "git commit"
      - "git push"
      - "git pull"
      - "git merge"
      - "git checkout"
    level: "ask"             # These need user approval
  - type: "filesystem"
    paths: ["~/Projects/**"]
    actions: ["read", "list"]
    level: "auto"

# Tools this skill provides to the agent
tools:
  - name: "git_status"
    description: "Check git status of a repository"
  - name: "git_log"
    description: "View recent git commits"
  - name: "git_diff"
    description: "Show changes in working directory"
  - name: "git_commit"
    description: "Stage and commit changes"
  - name: "git_push"
    description: "Push commits to remote"

# Integrity
checksum: "sha256:abc123..."
```

### Entry Point (index.ts)

```typescript
import { Skill, MamaCore, Tool } from '@mama/sdk';
import { tools } from './tools';

export const skill: Skill = {
  name: 'git-manager',
  version: '1.0.0',

  async activate(mama: MamaCore): Promise<void> {
    // Initialization logic
    // mama provides ONLY the capabilities declared in manifest
  },

  async deactivate(): Promise<void> {
    // Cleanup
  },

  tools,
};
```

---

## Built-in Skills (MVP)

### 1. filesystem
Core file operations: read, write, list, search, move, copy.
Uses: FsCapability.

### 2. shell
Execute system commands with safety classification.
Uses: ShellCapability.

### 3. git-manager
Git operations: status, log, diff, commit, push, pull, branch.
Uses: ShellCapability (git commands), FsCapability (read repo files).

### 4. web-search
Search the web using a search API or scraping.
Uses: NetworkCapability.

### 5. notes
Take notes, create documents, manage a personal knowledge base in ~/.mama/notes/.
Uses: FsCapability (workspace only).

### 6. system-monitor
System info: CPU, memory, disk, processes, network.
Uses: ShellCapability (safe commands only).

---

## Skill Lifecycle

```
Install → Verify → Approve → Activate → Use → Deactivate → Uninstall

1. INSTALL:   Copy skill files to ~/.mama/skills/{name}/
2. VERIFY:    Check manifest.yaml integrity (checksum)
3. APPROVE:   Show user what capabilities the skill needs
4. ACTIVATE:  Load skill, create sandboxed capability instances
5. USE:       Agent can invoke skill's tools
6. DEACTIVATE: Unload skill, revoke capabilities
7. UNINSTALL: Remove skill files
```

---

## Skill Sandboxing

Each skill gets its own sandboxed capability instances:

```typescript
class SkillSandbox {
  private allowedCapabilities: Map<string, CapabilityGrant>;

  constructor(manifest: SkillManifest) {
    // Create restricted capabilities based on manifest
    for (const cap of manifest.capabilities) {
      this.allowedCapabilities.set(cap.type, {
        type: cap.type,
        restrictions: cap,
        // The actual capability is wrapped to enforce restrictions
      });
    }
  }

  async execute(capability: string, action: string, params: unknown): Promise<CapabilityResult> {
    const grant = this.allowedCapabilities.get(capability);

    if (!grant) {
      // Skill trying to use a capability it didn't declare
      await audit.log({
        type: 'SKILL_VIOLATION',
        skill: this.manifest.name,
        attemptedCapability: capability,
        action,
      });
      throw new PermissionError(`Skill ${this.manifest.name} does not have ${capability} capability`);
    }

    // Further check: is this specific action within the grant?
    if (!this.isActionAllowed(grant, action, params)) {
      throw new PermissionError(`Skill ${this.manifest.name}: action ${action} not allowed for ${capability}`);
    }

    // Execute through the real capability sandbox
    return await sandbox.execute(capability, action, params);
  }
}
```

---

## Skill Development (Future)

For V2, users and community can create skills:

```bash
# Create a new skill scaffold
mama skill create my-skill

# Test a skill locally
mama skill test my-skill

# Package a skill
mama skill pack my-skill

# Publish to verified registry (future)
mama skill publish my-skill
```
