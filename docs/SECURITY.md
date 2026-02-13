# Security — Capability Sandbox ("Cap'n")

## Philosophy

**"No action without authorization. No authorization without audit."**

Unlike OpenClaw (no auth by default, credentials in plaintext, 15% malicious skills in marketplace), Mama treats security as the architecture, not a feature bolted on later.

Every action the agent takes — reading a file, executing a command, making an HTTP request — passes through the Capability Sandbox. The sandbox enforces permissions, logs everything, and asks the user when unsure.

---

## Capability System

### Core Concepts

```typescript
// A Capability wraps a type of system access
interface Capability {
  name: string;                    // "filesystem", "shell", "network"
  description: string;
  checkPermission(request: PermissionRequest): PermissionDecision;
  execute(params: unknown): Promise<CapabilityResult>;
}

// What the agent wants to do
interface PermissionRequest {
  capability: string;              // "filesystem"
  action: string;                  // "read"
  resource: string;                // "/home/alex/Documents/report.md"
  context: string;                 // Why the agent needs this
  requestedBy: string;             // "agent" | skill name
}

// The sandbox's decision
type PermissionDecision = {
  allowed: true;
  level: "auto" | "user-approved";
} | {
  allowed: false;
  reason: string;
  level: "denied";
};

// Result of every capability execution
interface CapabilityResult {
  success: boolean;
  output: unknown;
  error?: string;
  auditEntry: AuditEntry;
  durationMs: number;
}
```

---

## Three Capabilities (MVP)

### 1. Filesystem Capability (FsCap)

Controls all file system access.

**Permission model:**
```yaml
filesystem:
  workspace: "~/.mama/workspace"    # Full access always
  allowed_paths:
    - path: "~/.mama/**"
      actions: ["read", "write", "list"]
      level: "auto"
    - path: "~/Documents/**"
      actions: ["read", "list"]
      level: "auto"
    - path: "~/Documents/**"
      actions: ["write", "delete"]
      level: "ask"
    - path: "~/Projects/**"
      actions: ["read", "list"]
      level: "auto"
  denied_paths:
    - "~/.ssh/**"
    - "~/.gnupg/**"
    - "~/.mama/config.yaml"
    - "/etc/**"
    - "/usr/**"
    - "/var/**"
```

**Implementation:**

```typescript
class FsCapability implements Capability {
  name = "filesystem";

  checkPermission(request: PermissionRequest): PermissionDecision {
    const { action, resource } = request;
    const resolvedPath = resolvePath(resource);

    // 1. Check denied paths first (always wins)
    if (this.isDenied(resolvedPath)) {
      return { allowed: false, reason: `Path is denied: ${resource}`, level: "denied" };
    }

    // 2. Workspace always allowed
    if (this.isInWorkspace(resolvedPath)) {
      return { allowed: true, level: "auto" };
    }

    // 3. Check allowed paths with action matching
    const rule = this.findMatchingRule(resolvedPath, action);
    if (!rule) {
      return { allowed: false, reason: `No rule for ${action} on ${resource}`, level: "denied" };
    }

    return { allowed: true, level: rule.level };
  }

  async execute(params: FsParams): Promise<CapabilityResult> {
    const permission = this.checkPermission(params);

    if (!permission.allowed) {
      return this.denied(params, permission.reason);
    }

    if (permission.level === "ask") {
      const approved = await this.askUser(params);
      if (!approved) return this.denied(params, "User denied");
    }

    // Execute with audit
    const start = Date.now();
    try {
      const result = await this.executeFs(params);
      return this.success(params, result, Date.now() - start);
    } catch (error) {
      return this.error(params, error, Date.now() - start);
    }
  }
}
```

**Path resolution security:**
- All paths are resolved to absolute paths before checking
- Symlink targets are resolved and checked against rules
- Path traversal attacks (`../`) are detected and blocked
- Glob patterns use a safe matching library (micromatch)

---

### 2. Shell Capability (ShellCap)

Controls command execution.

**Three-tier command classification:**

```yaml
shell:
  # Auto-approved: read-only, informational commands
  safe_commands:
    - "ls"
    - "cat"
    - "head"
    - "tail"
    - "grep"
    - "find"
    - "wc"
    - "date"
    - "whoami"
    - "pwd"
    - "echo"
    - "which"
    - "file"
    - "stat"
    - "git status"
    - "git log"
    - "git diff"
    - "git branch"
    - "node --version"
    - "npm list"
    - "pnpm list"

  # Require user confirmation
  ask_commands:
    - "git commit"
    - "git push"
    - "git pull"
    - "git checkout"
    - "mkdir"
    - "cp"
    - "mv"
    - "touch"
    - "npm install"
    - "npm run"
    - "pnpm install"
    - "pnpm run"
    - "node"
    - "npx"

  # Never allowed
  denied_patterns:
    - "rm -rf"
    - "rm -r /"
    - "sudo"
    - "su "
    - "curl | bash"
    - "curl | sh"
    - "wget | bash"
    - "wget | sh"
    - "chmod 777"
    - "> /dev/"
    - "mkfs"
    - "dd if="
    - ":(){ :|:& };:"    # Fork bomb
    - "eval"
    - "exec"
    - "/dev/tcp"
    - "nc -l"             # Netcat listener
```

**Command parsing and analysis:**

```typescript
class ShellCapability implements Capability {
  name = "shell";

  checkPermission(request: PermissionRequest): PermissionDecision {
    const command = request.resource;

    // 1. Parse command into segments (handle pipes, chains)
    const segments = parseCommand(command);

    // 2. Check EACH segment against rules
    for (const segment of segments) {
      // Check denied patterns first
      if (this.matchesDenied(segment)) {
        return {
          allowed: false,
          reason: `Command contains denied pattern: ${segment}`,
          level: "denied"
        };
      }
    }

    // 3. Determine highest required permission level
    const levels = segments.map(s => this.classifyCommand(s));
    if (levels.includes("denied")) {
      return { allowed: false, reason: "Contains denied command", level: "denied" };
    }
    if (levels.includes("ask")) {
      return { allowed: true, level: "ask" };
    }
    return { allowed: true, level: "auto" };
  }

  private parseCommand(command: string): string[] {
    // Split on pipes (|), semicolons (;), && and ||
    // Each segment is checked independently
    // This prevents "ls ; rm -rf /" bypasses
    return command
      .split(/[|;&]/)
      .map(s => s.trim())
      .filter(Boolean);
  }
}
```

**Execution safety:**
- Commands run with reduced privileges (no sudo)
- Timeout: 30 seconds default, configurable per command
- Working directory restricted to allowed paths
- Environment variables sanitized (no PATH manipulation)
- Output captured and size-limited (prevent memory bombs)
- stderr captured separately for error analysis

---

### 3. Network Capability (NetworkCap)

Controls all outbound HTTP/HTTPS requests.

```yaml
network:
  # Always allowed
  allowed_domains:
    - "api.anthropic.com"      # Claude API
    - "api.telegram.org"       # Telegram Bot API
    - "localhost"              # Local services
    - "127.0.0.1"             # Local services
    - "api.github.com"        # GitHub API

  # Ask user for any new domain
  ask_unknown_domains: true

  # Never allowed
  denied_domains:
    - "*.onion"               # Tor
    - "pastebin.com"          # Data exfiltration risk

  # Rate limiting
  rate_limit:
    requests_per_minute: 30
    requests_per_hour: 500

  # Logging
  log_all_requests: true       # Log URL, method, status code
  log_response_bodies: false   # Don't log response content (privacy)
```

**Domain approval flow:**

```typescript
class NetworkCapability implements Capability {
  name = "network";

  // Domain approval is remembered for the session
  private approvedDomains: Set<string> = new Set();
  // Persistent approvals stored in config
  private persistentApprovals: Set<string>;

  checkPermission(request: PermissionRequest): PermissionDecision {
    const url = new URL(request.resource);
    const domain = url.hostname;

    // 1. Check denied
    if (this.isDenied(domain)) {
      return { allowed: false, reason: `Domain denied: ${domain}`, level: "denied" };
    }

    // 2. Check allowed
    if (this.isAllowed(domain) || this.approvedDomains.has(domain)) {
      return { allowed: true, level: "auto" };
    }

    // 3. Unknown domain → ask
    return { allowed: true, level: "ask" };
  }

  async approveForSession(domain: string): Promise<void> {
    this.approvedDomains.add(domain);
  }

  async approvePersistently(domain: string): Promise<void> {
    this.persistentApprovals.add(domain);
    await this.saveConfig();
  }
}
```

---

## Audit Log

Every capability execution generates an immutable audit entry:

```typescript
interface AuditEntry {
  id: string;               // UUID
  timestamp: Date;
  capability: string;       // "filesystem" | "shell" | "network"
  action: string;           // "read" | "write" | "execute" | "fetch"
  resource: string;         // Path, command, or URL
  params?: Record<string, unknown>;
  decision: "auto-approved" | "user-approved" | "user-denied" | "rule-denied" | "error";
  result: "success" | "error";
  output?: string;          // Truncated output (max 1KB)
  error?: string;
  durationMs: number;
  requestedBy: string;      // "agent" | skill name | "heartbeat" | "cron:jobname"
}
```

**Audit log properties:**
- Append-only (no updates, no deletes through the agent)
- Stored in SQLite with WAL mode for crash safety
- User can view via `mama audit` CLI command or API
- Searchable by capability, action, time range, result
- Exportable to JSON for external analysis

---

## User Approval Flow

When the sandbox needs user approval:

**Terminal:**
```
┌──────────────────────────────────────────┐
│ 🔒 Mama needs your approval              │
│                                          │
│ Action: Write file                       │
│ Path:   ~/Documents/meeting-notes.md     │
│ Reason: Save meeting notes you dictated  │
│ Size:   ~2.4 KB                          │
│                                          │
│ [y] Approve  [n] Deny  [a] Always allow  │
│ [s] Allow for session  [v] View content  │
└──────────────────────────────────────────┘
```

**Telegram:**
```
🔒 Mama needs your approval

Action: Write file
Path: ~/Documents/meeting-notes.md
Reason: Save meeting notes you dictated

[✅ Approve] [❌ Deny] [🔓 Always Allow]
```

**Approval options:**
- **Approve**: Allow this one time
- **Deny**: Block this action
- **Always Allow**: Add persistent rule (e.g., "always allow write to ~/Documents/meeting-notes.md")
- **Allow for Session**: Allow until Mama restarts
- **View Content**: Show what will be written/executed before deciding

---

## Skills Sandboxing

Skills declare their required capabilities in a manifest:

```typescript
interface SkillManifest {
  name: "git-manager",
  version: "1.0.0",
  capabilities: [
    {
      type: "filesystem",
      paths: ["~/Projects/**"],
      actions: ["read", "list"]
    },
    {
      type: "shell",
      commands: ["git status", "git log", "git diff", "git branch"]
    }
  ]
}
```

**At install time:**
1. Mama reads the manifest
2. Shows the user what permissions the skill needs
3. User approves or denies
4. If approved, the skill gets ONLY those capabilities
5. Any attempt to exceed declared capabilities → blocked + audit log + alert

This is fundamentally different from OpenClaw where skills can do whatever they want.

---

## Threat Model

| Threat | Mitigation |
|---|---|
| Prompt injection via messages | Input sanitization + capability sandbox limits damage |
| Malicious skill installation | Manifest-declared permissions, sandboxing, integrity check |
| Data exfiltration via network | Domain whitelist + all requests logged |
| Unauthorized file access | Path-based permissions with deny-first rules |
| Command injection | Command parsing, denied patterns, no sudo/eval |
| Config tampering | Config file in denied paths, encrypted at rest |
| Credential exposure | Env vars for secrets, never stored in plaintext in config |
| Memory poisoning | Consolidation uses confidence scoring, contradictions flagged |
| Replay attacks on API | Bearer token + timestamp validation |
| Physical access to machine | SQLite encryption key from OS keychain |

---

## Security Principles Summary

1. **Deny by default** — If no rule explicitly allows an action, it's denied
2. **Least privilege** — Skills and tasks get minimum needed permissions
3. **Defense in depth** — Multiple layers (sandbox + audit + user approval)
4. **Transparent** — Every action logged, user can always see what happened
5. **Recoverable** — Audit log enables understanding and undoing actions
6. **No silent failures** — Denied actions are reported, not silently dropped
