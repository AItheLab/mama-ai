# Roadmap — Mama Development Phases

## Overview

4 phases, each producing a working, testable increment. Phase 1 is the foundation — nothing works without it. Each subsequent phase adds a layer of capability.

Current status (February 13, 2026):
- Phase 1: Complete
- Phase 2: Complete
- Phase 3: Complete
- Phase 4: Pending

```
Phase 1: Foundation          (Week 1-2)  → Agent that thinks and talks
Phase 2: Hands                (Week 2-3)  → Agent that acts (sandbox + tools)
Phase 3: Brain                (Week 3-4)  → Agent that remembers (memory engine)
Phase 4: Life                 (Week 4-5)  → Agent that lives (scheduler + Telegram)
```

---

## Phase 1: Foundation — "Agent that thinks and talks"

**Goal:** A working agent loop in the terminal that connects to Claude/Ollama and can have conversations with context.

**Deliverables:**
- Project scaffolding (TypeScript, build, test, lint)
- LLM Router (Claude + Ollama providers)
- Basic ReAct agent loop (reason → respond, no tools yet)
- Terminal channel (CLI interface)
- Configuration system (YAML + Zod validation)
- Basic working memory (context window management)
- SOUL.md template and loader

**Exit criteria:**
- `pnpm dev` launches Mama in terminal
- User can chat with Mama
- Mama uses Claude for complex queries, Ollama for simple ones
- Configuration loads from mama.config.yaml
- All tests pass

**Details:** [PHASE-1.md](./PHASE-1.md)

---

## Phase 2: Hands — "Agent that acts"

**Goal:** The agent can interact with the system through the capability sandbox.

**Deliverables:**
- Capability Sandbox framework
- Filesystem Capability (read, write, list with permissions)
- Shell Capability (execute with safe/ask/deny classification)
- Network Capability (HTTP with domain whitelist)
- Audit log (immutable, SQLite)
- Tool definitions for core capabilities
- User approval flow (terminal)
- Agent loop upgraded with tool use (ReAct with actions)

**Exit criteria:**
- Mama can read/write files within allowed paths
- Mama asks for permission on protected operations
- Mama can execute safe shell commands
- All actions logged in audit trail
- Denied actions are blocked and reported
- Agent can plan and execute multi-step tasks

**Details:** [PHASE-2.md](./PHASE-2.md)

---

## Phase 3: Brain — "Agent that remembers"

**Goal:** Full memory system with Sleep Time consolidation.

**Deliverables:**
- SQLite database setup with schema and migrations
- Episodic memory (store all interactions with embeddings)
- Embedding generation via Ollama (nomic-embed-text)
- Semantic search on episodic memory
- Consolidated memory store
- Sleep Time consolidation engine
- Memory retrieval pipeline (inject relevant memories into context)
- Memory decay and forgetting logic
- SOUL.md auto-update from consolidated memories
- CLI commands: `mama memory search`, `mama memory list`, `mama memory forget`

**Exit criteria:**
- All conversations stored as episodes with embeddings
- Mama can recall past conversations semantically
- Consolidation runs and produces meaningful memories
- Soul.md reflects consolidated knowledge
- Memory decays over time for unreinforced items
- Context includes relevant memories for each conversation

**Details:** [PHASE-3.md](./PHASE-3.md)

---

## Phase 4: Life — "Agent that lives"

**Goal:** Mama runs 24/7, proactively helps, and is reachable via Telegram.

**Deliverables:**
- Cron job system (create, list, enable/disable, delete)
- Heartbeat system (periodic wake + HEARTBEAT.md check)
- Event triggers (filesystem watcher, webhook endpoint)
- Telegram channel (grammY bot)
- Telegram approval flow (inline keyboards)
- REST API (local, for integrations)
- Daemon mode (run as background service)
- Install script (curl one-liner)
- Basic skill system (loader + built-in skills)
- Cost tracking dashboard (CLI)

**Exit criteria:**
- Mama runs as a daemon
- User can chat via Telegram
- Cron jobs execute on schedule
- Heartbeat wakes agent and checks for needed actions
- User can approve/deny actions via Telegram
- Cost tracking shows LLM usage and spend
- `curl ... | sh` installs Mama on a fresh Linux machine

**Details:** [PHASE-4.md](./PHASE-4.md)

---

## Post-MVP (Future)

- Multi-user support with isolation
- Verified skill marketplace
- Web dashboard
- Proactive intelligence (anticipate needs)
- WhatsApp channel
- Voice input/output
- Mobile companion app
- End-to-end encryption for channels
- Self-updating mechanism
