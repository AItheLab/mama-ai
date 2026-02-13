# CLAUDE.md — Instructions for Claude Code

## Project: Mama — Personal AI Agent

Read this file first. Then read the documents referenced below before starting any work.

---

## Essential Context

**Read these before writing any code:**
1. `MASTER.md` — Project overview, tech stack, project structure
2. `docs/ARCHITECTURE.md` — System architecture, data model, configuration
3. `docs/AGENTS-WORKFLOW.md` — How to work on this project (code style, testing, commits)

**Read these when working on specific systems:**
- Memory work → `docs/MEMORY.md`
- Security/sandbox work → `docs/SECURITY.md`
- Agent loop work → `docs/AGENT-LOOP.md`
- Skills work → `docs/SKILLS.md`

**Read for current tasks:**
- `tasks/ROADMAP.md` — Phase overview
- `tasks/PHASE-{N}.md` — Detailed tasks for current phase

---

## Quick Reference

### Tech Stack
- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22+
- **Package manager:** pnpm
- **Build:** tsup
- **Test:** vitest
- **Lint:** biome
- **Database:** SQLite (better-sqlite3 + sqlite-vec)
- **LLM:** Anthropic SDK (Claude) + Ollama (local models)
- **Telegram:** grammY
- **CLI:** commander + ink

### Key Patterns
- **Result type** for fallible operations (no throwing for expected failures)
- **Zod schemas** for all external data validation
- **Structured logging** (JSON, never log secrets)
- **Capability sandbox** for all system access (files, shell, network)
- **Audit trail** for all capability executions

### Commands
```bash
pnpm dev          # Development mode (auto-reload)
pnpm build        # Production build
pnpm test         # Run tests (watch mode)
pnpm test:run     # Run tests (single run)
pnpm typecheck    # TypeScript check
pnpm lint         # Biome check
pnpm lint:fix     # Auto-fix lint issues
```

### Directory Structure
```
src/
├── core/          # Agent runtime, planner, executor
├── memory/        # Working, episodic, consolidated memory
├── sandbox/       # Capability-based security system
├── scheduler/     # Cron, heartbeat, triggers
├── llm/           # LLM router, providers, cost tracking
├── channels/      # Terminal, Telegram, REST API
├── skills/        # Skill loader, registry, built-in skills
├── config/        # Configuration loading and validation
└── utils/         # Logger, helpers
```

---

## Rules

1. **NEVER hardcode secrets or API keys** — Use env vars
2. **ALWAYS validate external input** — Zod schemas
3. **ALWAYS go through sandbox** — Never access fs/shell/network directly
4. **ALWAYS log security events** — Audit trail
5. **ALWAYS write tests** — No code without tests
6. **ALWAYS use strict TypeScript** — No `any`, no `as` without justification
7. **Commit often** — Small, focused commits with conventional messages
8. **Read before code** — Check existing modules before creating new ones

---

## Working with Alex

- Alex is the architect. Major decisions go through him.
- Implementation details are your call. Document your reasoning.
- If blocked, try an alternative. If truly stuck, ask Alex.
- Alex values: security, clean code, pragmatism over perfection.
- Prefer working code over perfect abstractions.
