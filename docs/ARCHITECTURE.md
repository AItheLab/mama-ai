# Architecture — Mama Agent

## System Overview

```
┌──────────────────────────────────────────────────────────┐
│                      MAMA CORE                            │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   Agent      │  │   Memory     │  │   Scheduler    │  │
│  │   Runtime    │  │   Engine     │  │                │  │
│  │             │  │              │  │  • Cron Jobs   │  │
│  │  • ReAct    │  │  • Working   │  │  • Heartbeat   │  │
│  │  • Planner  │  │  • Episodic  │  │  • Triggers    │  │
│  │  • Executor │  │  • Sleep     │  │  • Webhooks    │  │
│  │  • Context  │  │    Consolidation                  │  │
│  └──────┬──────┘  └──────────────┘  └────────────────┘  │
│         │                                                 │
│  ┌──────▼────────────────────────────────────────────┐   │
│  │          CAPABILITY SANDBOX ("Cap'n")              │   │
│  │                                                    │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │   │
│  │  │FS Cap    │  │Shell Cap │  │Network Cap   │    │   │
│  │  │          │  │          │  │              │    │   │
│  │  │ r/w/x    │  │ allow/   │  │ domain       │    │   │
│  │  │ per path │  │ deny     │  │ whitelist    │    │   │
│  │  │ + globs  │  │ per cmd  │  │ + rate limit │    │   │
│  │  └──────────┘  └──────────┘  └──────────────┘    │   │
│  │                                                    │   │
│  │  ┌──────────────────────────────────────────┐     │   │
│  │  │         AUDIT LOG (immutable)             │     │   │
│  │  └──────────────────────────────────────────┘     │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  ┌───────────────────────────────────────────────────┐   │
│  │              LLM ROUTER                            │   │
│  │  Claude (complex) ←→ Ollama (simple/fast/private) │   │
│  │  + cost tracking + fallback + smart routing        │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  ┌───────────────────────────────────────────────────┐   │
│  │              CHANNEL LAYER                         │   │
│  │  Terminal (TUI) │ Telegram │ REST API (local)     │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  ┌───────────────────────────────────────────────────┐   │
│  │              SKILL SYSTEM                          │   │
│  │  Built-in skills │ User skills │ Verified registry │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘

Storage: ~/.mama/
├── config.yaml          # Encrypted configuration
├── mama.db              # SQLite (memory, audit, jobs)
├── soul.md              # Agent identity (auto-evolving)
├── skills/              # Installed skills
├── workspace/           # Agent's sandbox workspace
└── logs/                # Operation logs
```

---

## Component Details

### 1. Agent Runtime

The brain of Mama. Implements a ReAct (Reason-Act-Observe) loop with planning capabilities.

**Flow:**
```
User Message
    │
    ▼
┌─────────┐     ┌──────────┐     ┌──────────┐
│ REASON  │────▶│  PLAN    │────▶│ CONFIRM  │
│         │     │          │     │ (if needed)│
│ Analyze │     │ Break    │     │          │
│ context │     │ into     │     │ Show plan│
│ + memory│     │ steps    │     │ to user  │
└─────────┘     └──────────┘     └────┬─────┘
                                      │
                                      ▼
                               ┌──────────┐
                               │ EXECUTE  │◄──┐
                               │          │   │
                               │ Run step │   │ Loop until
                               │ via      │   │ all steps
                               │ sandbox  │   │ complete
                               └────┬─────┘   │
                                    │         │
                                    ▼         │
                               ┌──────────┐   │
                               │ OBSERVE  │───┘
                               │          │
                               │ Check    │
                               │ result   │
                               │ Adapt    │
                               └────┬─────┘
                                    │
                                    ▼
                               ┌──────────┐
                               │ RESPOND  │
                               │          │
                               │ Report   │
                               │ to user  │
                               └──────────┘
```

**Key design decisions:**
- The agent ALWAYS plans before executing multi-step tasks
- Plans with side-effects (write, delete, execute) require user confirmation
- Read-only operations (search, list, analyze) execute immediately
- Each step is independently audited
- If any step fails, the agent can re-plan from that point
- Context window is managed with progressive summarization (older context → compressed)

**Agent Configuration (soul.md):**
```markdown
# Mama — Soul Definition

## Identity
You are Mama, a personal AI agent owned by {user_name}.
Your job is to take care of {user_name}'s digital life.

## Personality
- Proactive but not intrusive
- Honest — if you can't do something, say so
- Security-conscious — always explain what you're about to do
- Efficient — minimal steps, maximum result

## Knowledge
{auto-populated from consolidated memory}

## Active Goals
{auto-populated from user goals and patterns}

## Boundaries
{auto-populated from permission config}
```

---

### 2. Memory Engine

See [MEMORY.md](./MEMORY.md) for full specification.

Three-layer architecture:
- **Working Memory**: Current conversation context (LLM context window)
- **Episodic Memory**: All interactions stored with embeddings for semantic search
- **Consolidated Memory**: Sleep Time Architecture — background consolidation of patterns, preferences, facts

---

### 3. Capability Sandbox ("Cap'n")

See [SECURITY.md](./SECURITY.md) for full specification.

Every tool/action the agent can take is wrapped in a capability that enforces permissions:

```typescript
interface Capability {
  name: string;
  description: string;
  permissions: Permission[];
  execute(params: unknown): Promise<CapabilityResult>;
}

interface Permission {
  resource: string;       // e.g., "fs:/home/alex/Documents/**"
  actions: Action[];      // e.g., ["read", "list"]
  level: "auto" | "ask" | "deny";
  expires?: Date;
}

interface CapabilityResult {
  success: boolean;
  output: unknown;
  auditEntry: AuditEntry; // Always generated
}
```

Permission levels:
- **auto**: Execute without asking (safe operations within allowed paths)
- **ask**: Prompt user for confirmation before executing
- **deny**: Never execute, even if asked

---

### 4. LLM Router

Intelligent model selection based on task characteristics:

```typescript
interface RoutingDecision {
  model: string;
  provider: "claude" | "ollama";
  reason: string;
  estimatedCost: number;
  estimatedLatency: number;
}
```

**Routing logic:**
| Task Type | Model | Reason |
|---|---|---|
| Complex reasoning, planning | Claude Sonnet/Opus | Best reasoning capability |
| Code generation & review | Claude Sonnet | Strong code understanding |
| Simple Q&A, translation | Ollama (local) | Free, fast, private |
| Memory consolidation | Claude Haiku | Good enough, cost-effective |
| Embedding generation | Ollama (nomic-embed) | Free, local, fast |
| Sensitive/private content | Ollama (local) | Data never leaves machine |
| Fallback (API down) | Ollama (local) | Always available |

**Cost tracking:**
Every LLM call is tracked:
```typescript
interface LLMUsage {
  timestamp: Date;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;        // USD
  taskType: string;
  latencyMs: number;
}
```

---

### 5. Scheduler

Three mechanisms for proactive behavior:

**Cron Jobs:**
- User-defined scheduled tasks
- Syntax: human-readable ("every Monday at 9am") → parsed to cron
- Stored in SQLite, survives restarts
- Example: "Check my GitHub notifications every 2 hours"

**Heartbeat:**
- Agent wakes at configurable interval (default: 30 min)
- Reads `~/.mama/heartbeat.md` — a file describing what to check
- Decides if any action is needed based on current state + memory
- Different from cron: "check if anything needs attention" vs "do this specific thing"

**Event Triggers:**
- File system watchers (e.g., "when a new file appears in ~/Downloads")
- Webhook endpoints (e.g., GitHub webhook → agent processes)
- Manual triggers via API

---

### 6. Channel Layer

All channels implement the same interface:

```typescript
interface Channel {
  name: string;
  send(message: MamaMessage): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface MamaMessage {
  text: string;
  format?: "plain" | "markdown";
  attachments?: Attachment[];
  replyTo?: string;
  priority?: "low" | "normal" | "high" | "urgent";
}
```

**Terminal Channel:**
- Rich TUI using Ink (React for CLI)
- Shows: conversation, status bar (memory items, active jobs, cost today), audit feed
- Supports inline confirmations for sandbox approvals

**Telegram Channel:**
- grammY framework
- Bot token stored encrypted in config
- Supports: text, files, inline keyboards for confirmations
- Whitelist of allowed Telegram user IDs (security)

**REST API:**
- Local only (127.0.0.1) by default
- Bearer token auth
- Endpoints: /message, /status, /jobs, /audit, /memory
- For integrations and future web UI

---

### 7. Skill System

See [SKILLS.md](./SKILLS.md) for full specification.

Skills are self-contained modules that extend Mama's capabilities:

```typescript
interface Skill {
  manifest: SkillManifest;
  tools: Tool[];
  activate(mama: MamaCore): Promise<void>;
  deactivate(): Promise<void>;
}

interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  requiredCapabilities: CapabilityRequest[]; // What permissions it needs
  checksum: string;                          // Integrity verification
}
```

**Key security feature:** Skills declare what capabilities they need in their manifest. Mama verifies this at install time and only grants those specific permissions. A skill that says it only needs filesystem read access CANNOT execute shell commands.

---

## Data Model (SQLite Schema)

```sql
-- Episodic memory
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  channel TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'agent' | 'system'
  content TEXT NOT NULL,
  embedding BLOB,              -- Vector embedding
  metadata JSON,               -- Extra context
  consolidated BOOLEAN DEFAULT FALSE
);

-- Consolidated memory
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  category TEXT NOT NULL,       -- 'fact' | 'preference' | 'pattern' | 'goal' | 'relationship'
  content TEXT NOT NULL,
  confidence REAL DEFAULT 1.0, -- 0.0 to 1.0
  source_episodes JSON,        -- Array of episode IDs that contributed
  embedding BLOB,
  active BOOLEAN DEFAULT TRUE  -- Can be "forgotten" (deactivated)
);

-- Audit log
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  capability TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  params JSON,
  result TEXT NOT NULL,        -- 'success' | 'denied' | 'error'
  output TEXT,
  approved_by TEXT,            -- 'auto' | 'user' | 'denied'
  duration_ms INTEGER
);

-- Scheduled jobs
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'cron' | 'trigger' | 'heartbeat'
  schedule TEXT,                -- Cron expression
  task TEXT NOT NULL,           -- Natural language task description
  enabled BOOLEAN DEFAULT TRUE,
  last_run DATETIME,
  next_run DATETIME,
  run_count INTEGER DEFAULT 0,
  last_result JSON
);

-- LLM usage tracking
CREATE TABLE llm_usage (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  task_type TEXT,
  latency_ms INTEGER
);

-- Skills registry
CREATE TABLE skills (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  installed_at DATETIME NOT NULL,
  manifest JSON NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  checksum TEXT NOT NULL
);
```

---

## Configuration (mama.config.yaml)

```yaml
# Mama Configuration
version: 1

# Agent identity
agent:
  name: "Mama"
  soul_path: "./soul.md"

# User info
user:
  name: "Alex"
  telegram_ids: []        # Allowed Telegram user IDs
  timezone: "Europe/Madrid"
  locale: "es-ES"

# LLM providers
llm:
  default_provider: "claude"
  providers:
    claude:
      api_key: "${MAMA_CLAUDE_API_KEY}"   # Env var reference
      default_model: "claude-sonnet-4-20250514"
      max_monthly_budget_usd: 50
    ollama:
      host: "http://localhost:11434"
      default_model: "llama3.2"
      embedding_model: "nomic-embed-text"

  # Routing rules
  routing:
    complex_reasoning: "claude"
    code_generation: "claude"
    simple_tasks: "ollama"
    embeddings: "ollama"
    memory_consolidation: "claude"
    private_content: "ollama"

# Channels
channels:
  terminal:
    enabled: true
  telegram:
    enabled: true
    bot_token: "${MAMA_TELEGRAM_TOKEN}"
  api:
    enabled: true
    host: "127.0.0.1"
    port: 3377

# Security / Sandbox
sandbox:
  filesystem:
    workspace: "~/.mama/workspace"
    allowed_paths:
      - path: "~/.mama/**"
        actions: ["read", "write", "list"]
        level: "auto"
      - path: "~/Documents/**"
        actions: ["read", "list"]
        level: "auto"
      - path: "~/Documents/**"
        actions: ["write"]
        level: "ask"
      - path: "~/Projects/**"
        actions: ["read", "list"]
        level: "auto"
    denied_paths:
      - "~/.ssh/**"
      - "~/.gnupg/**"
      - "~/.mama/config.yaml"    # Can't modify own config

  shell:
    safe_commands: ["ls", "cat", "head", "tail", "grep", "find", "wc", "date", "whoami", "pwd", "echo", "git status", "git log", "git diff"]
    ask_commands: ["git commit", "git push", "git pull", "mkdir", "cp", "mv", "npm", "pnpm", "node"]
    denied_patterns: ["rm -rf", "sudo", "curl | bash", "wget | sh", "chmod 777", "> /dev", "mkfs", "dd if="]

  network:
    allowed_domains: ["api.anthropic.com", "api.telegram.org", "localhost", "api.github.com"]
    ask_domains: true     # Ask for any new domain
    rate_limit_per_minute: 30
    log_all_requests: true

# Scheduler
scheduler:
  heartbeat:
    enabled: true
    interval_minutes: 30
    heartbeat_file: "~/.mama/heartbeat.md"
  max_concurrent_jobs: 3

# Memory
memory:
  consolidation:
    enabled: true
    interval_hours: 6           # Run consolidation every 6 hours
    min_episodes_to_consolidate: 10
    model: "claude"             # Use Claude for consolidation
  max_episodic_entries: 100000
  embedding_dimensions: 768     # nomic-embed-text dimensions
  search_top_k: 10             # Default semantic search results

# Logging
logging:
  level: "info"
  file: "~/.mama/logs/mama.log"
  max_size_mb: 50
  rotate: true
```
