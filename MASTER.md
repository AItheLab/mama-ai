# 🤱 MAMA — Personal AI Agent

> "The agent that takes care of you."

## Project Identity

- **Name**: Mama
- **Tagline**: Secure. Intelligent. Actually useful.
- **Creator**: Alex (AleksandarLabs)
- **License**: Open Core (Core OSS + Premium features TBD)
- **Stage**: MVP — Experimental / Personal use first

---

## What is Mama?

Mama is a **personal AI agent** that runs on your own hardware. Unlike chatbots that just respond, Mama **acts**: she manages your files, executes commands, remembers everything, learns your patterns, and proactively helps you — all through a secure, permission-based system.

Mama differentiates from existing solutions (OpenClaw, etc.) in three fundamental ways:

1. **Security-first**: Every action goes through a capability-based permission sandbox. No action without explicit authorization.
2. **Intelligent Memory**: Sleep Time Memory Architecture — not just storing data, but consolidating, prioritizing, connecting, and intelligently forgetting.
3. **Single install, runs anywhere**: One command, one binary-like experience. Mac, Linux, Raspberry Pi, VPS.

---

## Core Principles

1. **Security is not a feature, it's the architecture** — Capability-based sandbox from day zero
2. **Intelligence over integrations** — Fewer connections, but the agent truly understands what it does
3. **Memory as superpower** — Consolidate, prioritize, connect, forget
4. **Runs anywhere** — Mac, Linux VPS, Raspberry Pi. Same experience
5. **Useful from day one** — Not a demo. A tool Alex uses daily
6. **Transparent** — Every action logged, every decision explainable

---

## Tech Stack

| Component | Technology | Reason |
|---|---|---|
| Language | **TypeScript** (strict mode) | Creator's expertise, fast iteration |
| Runtime | **Node.js 22+** (LTS) | Stable, cross-platform |
| Package Manager | **pnpm** | Fast, disk-efficient |
| Build | **tsup** (esbuild-based) | Fast builds, single output |
| Memory Store | **SQLite** (better-sqlite3) + **sqlite-vec** | Embedded, no server, vector search |
| Scheduler | **node-cron** + custom heartbeat | Proven cron + custom proactive system |
| Telegram | **grammY** | Modern, TypeScript-first, well maintained |
| LLM: Claude | **@anthropic-ai/sdk** | Official SDK |
| LLM: Ollama | **ollama** (npm) | Official client |
| CLI | **commander** + **ink** (React for CLI) | Rich terminal UI |
| Config | **YAML** + **zod** validation | Human-readable, type-safe |
| Encryption | **Node.js crypto** (AES-256-GCM) | Native, no dependencies |
| Testing | **vitest** | Fast, TypeScript native |
| Linting | **biome** | Fast, replaces eslint+prettier |

---

## Target Platforms

| Platform | Priority | Notes |
|---|---|---|
| macOS (Apple Silicon) | P0 | Creator's main machine |
| Linux x64 (VPS) | P0 | DigitalOcean/Hetzner deployment |
| Linux ARM64 (Raspberry Pi) | P1 | Always-on home server |
| Windows (WSL2) | P2 | Future |

---

## Project Structure

```
mama/
├── src/
│   ├── core/                  # Agent runtime, ReAct loop
│   │   ├── agent.ts           # Main agent orchestrator
│   │   ├── planner.ts         # Multi-step planning
│   │   ├── executor.ts        # Action execution
│   │   └── context.ts         # Context window management
│   ├── memory/                # Memory engine
│   │   ├── working.ts         # Active conversation context
│   │   ├── episodic.ts        # Interaction history + vector search
│   │   ├── consolidated.ts    # Sleep Time consolidation
│   │   ├── store.ts           # SQLite + vector store
│   │   └── soul.ts            # SOUL.md manager (agent identity)
│   ├── sandbox/               # Capability-based security
│   │   ├── capabilities.ts    # Permission system
│   │   ├── fs-cap.ts          # Filesystem capability
│   │   ├── shell-cap.ts       # Shell capability
│   │   ├── network-cap.ts     # Network capability
│   │   └── audit.ts           # Immutable audit log
│   ├── scheduler/             # Jobs & Heartbeat
│   │   ├── cron.ts            # Cron job manager
│   │   ├── heartbeat.ts       # Proactive wake system
│   │   └── triggers.ts        # Event-based triggers
│   ├── llm/                   # LLM Router
│   │   ├── router.ts          # Intelligent model selection
│   │   ├── providers/
│   │   │   ├── claude.ts      # Anthropic Claude
│   │   │   └── ollama.ts      # Local models via Ollama
│   │   └── cost-tracker.ts    # Token/cost tracking
│   ├── channels/              # Communication channels
│   │   ├── terminal.ts        # CLI interface
│   │   ├── telegram.ts        # Telegram bot
│   │   └── api.ts             # REST API (local)
│   ├── skills/                # Pluggable skill system
│   │   ├── loader.ts          # Skill loader & validator
│   │   ├── registry.ts        # Skill registry
│   │   └── built-in/          # Core skills
│   │       ├── filesystem.ts  # File operations
│   │       ├── git.ts         # Git operations
│   │       ├── web-search.ts  # Web search
│   │       ├── notes.ts       # Note taking
│   │       └── system.ts      # System info & monitoring
│   ├── config/                # Configuration
│   │   ├── schema.ts          # Zod schemas
│   │   ├── loader.ts          # Config loader
│   │   └── defaults.ts        # Default configuration
│   └── index.ts               # Entry point
├── templates/
│   └── SOUL.md                # Default agent identity template
├── tests/
├── docs/                      # This documentation
├── package.json
├── tsconfig.json
├── biome.json
└── mama.config.yaml           # User configuration
```

---

## Documentation Index

| Document | Purpose |
|---|---|
| [MASTER.md](./MASTER.md) | This file — project overview |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Detailed technical architecture |
| [docs/MEMORY.md](./docs/MEMORY.md) | Sleep Time Memory Architecture |
| [docs/SECURITY.md](./docs/SECURITY.md) | Capability Sandbox system |
| [docs/AGENT-LOOP.md](./docs/AGENT-LOOP.md) | Agent runtime & ReAct loop |
| [docs/SKILLS.md](./docs/SKILLS.md) | Skill system specification |
| [docs/AGENTS-WORKFLOW.md](./docs/AGENTS-WORKFLOW.md) | How Claude Code agents work on this project |
| [tasks/ROADMAP.md](./tasks/ROADMAP.md) | Phased development plan |
| [tasks/PHASE-1.md](./tasks/PHASE-1.md) | Phase 1 detailed tasks |
| [tasks/PHASE-2.md](./tasks/PHASE-2.md) | Phase 2 detailed tasks |
| [tasks/PHASE-3.md](./tasks/PHASE-3.md) | Phase 3 detailed tasks |
| [tasks/PHASE-4.md](./tasks/PHASE-4.md) | Phase 4 detailed tasks |
