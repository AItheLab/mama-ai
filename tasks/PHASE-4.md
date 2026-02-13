# Phase 4: Life — Detailed Tasks

## Prerequisites
- Phase 3 complete
- Agent can think, act, and remember
- SQLite database fully operational

---

## Task 4.1: Cron Job System

**Priority:** P0
**Estimated effort:** 2 hours

### Steps:
1. Create `src/scheduler/cron.ts`:
   - Install: `pnpm add node-cron`
   - `createJob(job: NewJob): Promise<string>`
     - Parse natural language schedule → cron expression (use LLM for parsing)
     - Store in SQLite jobs table
     - Register with node-cron
   - `listJobs(): Promise<Job[]>`
   - `enableJob(id: string): Promise<void>`
   - `disableJob(id: string): Promise<void>`
   - `deleteJob(id: string): Promise<void>`
   - On job trigger:
     - Create a new agent session
     - Execute the task description through the agent
     - Store result in job record
     - Log in audit trail

2. Create `src/scheduler/types.ts`:
   - Job interfaces
   - Schedule types (cron expression, natural language)

3. Persistence:
   - On startup, load all enabled jobs from SQLite
   - Register with node-cron
   - Handle timezone (from config)

4. Add tools:
   - `create_scheduled_job`: Agent can create jobs for user
   - `list_scheduled_jobs`: View current jobs
   - `manage_job`: Enable/disable/delete

5. Add CLI commands:
   - `mama jobs list`
   - `mama jobs create <schedule> <task>`
   - `mama jobs enable/disable/delete <id>`

6. Tests:
   - Jobs create and persist
   - Cron expressions are valid
   - Jobs execute on schedule (mocked timer)
   - Job results are stored
   - Jobs survive restart (loaded from DB)

---

## Task 4.2: Heartbeat System

**Priority:** P0
**Depends on:** 4.1
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/scheduler/heartbeat.ts`:
   - Periodic wake at configurable interval (default: 30 min)
   - On wake:
     1. Read `~/.mama/heartbeat.md` (user-editable check list)
     2. Check current system state
     3. Send to agent: "Review these heartbeat items and take action if needed"
     4. Agent decides what (if anything) to do
     5. Execute actions through normal agent loop
     6. Log heartbeat execution

2. Create `templates/heartbeat.md`:
   ```markdown
   # Mama Heartbeat Checks

   ## Check these periodically:
   - Are there any unread notifications that need attention?
   - Are there any upcoming deadlines in the next 24 hours?
   - Is the system running normally (disk space, memory)?

   ## Proactive tasks:
   - If new files appear in ~/Downloads, organize them
   - Remind Alex about training schedule
   ```

3. Heartbeat is different from cron:
   - Cron: "Do X at time Y"
   - Heartbeat: "Wake up, assess the situation, decide if anything needs doing"

4. Tests:
   - Heartbeat triggers at configured interval
   - Heartbeat.md is read and processed
   - Agent can decide to take action or not
   - Heartbeat results are logged

---

## Task 4.3: Event Triggers

**Priority:** P1
**Depends on:** 4.1
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/scheduler/triggers.ts`:
   - **File watcher**: Watch specified directories for changes
     - Uses `fs.watch` (native) or chokidar for robustness
     - Trigger agent when files are created/modified/deleted
   - **Webhook**: HTTP endpoint for external triggers
     - POST to `/hooks/{hook_id}` with payload
     - Bearer token authentication
     - Trigger agent with webhook data as context

2. Install: `pnpm add chokidar`

3. Configuration:
   ```yaml
   triggers:
     file_watchers:
       - path: "~/Downloads"
         events: ["add"]
         task: "A new file was downloaded: {filename}. Categorize and organize it."
     webhooks:
       enabled: true
       port: 3378   # Separate from API
       hooks:
         - id: "github"
           token: "${MAMA_WEBHOOK_GITHUB_TOKEN}"
           task: "Process this GitHub webhook: {payload}"
   ```

4. Tests:
   - File watcher detects new files
   - Webhook receives and validates requests
   - Both trigger agent correctly

---

## Task 4.4: Telegram Channel

**Priority:** P0
**Estimated effort:** 3 hours

### Steps:
1. Install: `pnpm add grammy`

2. Create `src/channels/telegram.ts`:
   - Bot initialization with token from config
   - Whitelist check: only respond to allowed Telegram user IDs
   - Message handling:
     - Text messages → agent.processMessage
     - Document attachments → save to workspace, inform agent
     - Voice messages → transcription (future), for now: inform user text only
   - Response formatting:
     - Markdown formatting for Telegram
     - Long messages split into chunks (4096 char limit)
     - Code blocks formatted properly

3. Approval flow for Telegram:
   - When sandbox needs approval, send inline keyboard:
     ```
     🔒 Permission Request
     Action: write_file
     Path: ~/Documents/notes.md
     
     [✅ Approve] [❌ Deny] [🔓 Always]
     ```
   - Handle callback queries
   - Timeout: if no response in 5 minutes, deny

4. Proactive messages:
   - Heartbeat and cron results sent via Telegram
   - Priority levels affect notification behavior:
     - low: silent message
     - normal: regular message
     - high: message with notification
     - urgent: multiple messages until acknowledged

5. Commands:
   - `/status` — Agent status, active jobs, memory stats
   - `/jobs` — List scheduled jobs
   - `/audit` — Recent audit entries
   - `/cost` — LLM usage today/month
   - `/memory <query>` — Search memories

6. Tests:
   - Bot connects and receives messages (mocked grammY)
   - Whitelist blocks unauthorized users
   - Approval flow with inline keyboards works
   - Long messages are split correctly
   - Proactive messages send correctly

---

## Task 4.5: REST API (Local)

**Priority:** P1
**Estimated effort:** 1.5 hours

### Steps:
1. Install: `pnpm add hono` (lightweight, fast HTTP framework)

2. Create `src/channels/api.ts`:
   - Bind to 127.0.0.1 only (no external access by default)
   - Bearer token auth (token from config or auto-generated)
   - Endpoints:
     - `POST /api/message` — Send message to agent
     - `GET /api/status` — Agent status
     - `GET /api/jobs` — List jobs
     - `POST /api/jobs` — Create job
     - `GET /api/audit` — Query audit log
     - `GET /api/memory/search?q=` — Search memories
     - `GET /api/cost` — Usage and cost data
   - JSON request/response
   - Error handling with proper HTTP status codes

3. Tests:
   - Auth required for all endpoints
   - Invalid token returns 401
   - All endpoints return correct data
   - localhost binding works

---

## Task 4.6: Daemon Mode

**Priority:** P0
**Depends on:** 4.1, 4.2, 4.4
**Estimated effort:** 1.5 hours

### Steps:
1. Update `src/index.ts`:
   - Add `mama daemon` command
   - Runs without terminal channel (headless)
   - Starts: Telegram + API + Scheduler + Heartbeat
   - PID file at `~/.mama/mama.pid`
   - Graceful shutdown on SIGTERM/SIGINT

2. Create `src/daemon.ts`:
   - `startDaemon()`: Initialize all services, log to file
   - `stopDaemon()`: Graceful shutdown of all services
   - Health check: periodic self-check, restart on failure

3. Create systemd service file: `templates/mama.service`
   ```ini
   [Unit]
   Description=Mama AI Agent
   After=network.target

   [Service]
   Type=simple
   ExecStart=/usr/local/bin/mama daemon
   Restart=on-failure
   RestartSec=10
   User=%i
   Environment=MAMA_HOME=%h/.mama

   [Install]
   WantedBy=default.target
   ```

4. Create launchd plist: `templates/com.mama.agent.plist` (for macOS)

5. CLI commands:
   - `mama daemon start` — Start as daemon
   - `mama daemon stop` — Stop daemon
   - `mama daemon status` — Check if running
   - `mama daemon logs` — Tail log file

6. Tests:
   - Daemon starts and creates PID file
   - Daemon stops gracefully
   - Services initialize in correct order
   - Crash recovery works

---

## Task 4.7: Install Script

**Priority:** P1
**Depends on:** All above
**Estimated effort:** 1 hour

### Steps:
1. Create `scripts/install.sh`:
   ```bash
   #!/bin/bash
   # Install Mama AI Agent
   # Usage: curl -sSL https://mama.dev/install | bash

   set -euo pipefail

   # Check prerequisites
   check_node_version()   # Node 22+
   check_pnpm()           # or install it
   check_ollama()         # Optional, warn if missing

   # Install
   pnpm add -g mama-agent

   # Initialize
   mama init              # Interactive setup wizard

   # Done
   echo "🤱 Mama is ready. Run 'mama chat' to start."
   ```

2. Create `mama init` command:
   - Interactive setup wizard
   - Ask for: name, Claude API key, Telegram bot token (optional)
   - Create `~/.mama/` directory structure
   - Generate default config
   - Generate default soul.md
   - Generate default heartbeat.md
   - Test LLM connection
   - Optional: configure Ollama models

---

## Task 4.8: Cost Tracking Dashboard

**Priority:** P1
**Depends on:** LLM usage stored in SQLite (from Phase 1 cost tracker update)
**Estimated effort:** 1 hour

### Steps:
1. Persist LLM usage to SQLite (update cost-tracker from Phase 1)

2. Add CLI command: `mama cost [--period today|week|month|all]`
   - Show: total tokens, total cost, breakdown by model, average per day
   - Pretty terminal output with tables/bars

3. Add Telegram command: `/cost`

---

## Task 4.9: Basic Skill Loader

**Priority:** P1
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/skills/loader.ts`:
   - Scan `~/.mama/skills/` for skill directories
   - Read and validate manifest.yaml
   - Verify checksum
   - Create sandboxed capability instances per skill manifest
   - Register skill tools with the agent

2. Create `src/skills/registry.ts`:
   - Global skill registry
   - `install(path: string): Promise<void>`
   - `uninstall(name: string): Promise<void>`
   - `list(): Skill[]`
   - `enable(name: string): Promise<void>`
   - `disable(name: string): Promise<void>`

3. Create built-in skills (as separate directories under `src/skills/built-in/`):
   - `filesystem/` — File operations (already implemented as tools, wrap as skill)
   - `git-manager/` — Git operations
   - `notes/` — Note-taking in `~/.mama/notes/`
   - `system-monitor/` — System info (CPU, memory, disk)

4. Tests:
   - Skills load from directory
   - Manifest validation works
   - Sandboxed capabilities enforce limits
   - Built-in skills function correctly

---

## Task 4.10: Final Integration Test

**Priority:** P0
**Depends on:** All above

### Full system test:
1. `mama init` — creates config and workspace
2. `mama chat` — interactive terminal session
3. Have a conversation → stored as episodes
4. `mama daemon start` — runs as background service
5. Send message via Telegram → get response
6. Create a cron job via Telegram → confirm it's scheduled
7. Wait for heartbeat → check agent woke and assessed
8. `mama memory search "test"` → finds relevant memories
9. `mama audit --last 20` → shows recent actions
10. `mama cost` → shows spending
11. `mama daemon stop` — clean shutdown

### Checklist:
- [ ] Agent thinks (LLM routing works)
- [ ] Agent acts (sandbox works)
- [ ] Agent remembers (memory works)
- [ ] Agent lives (daemon, scheduler, telegram)
- [ ] Agent is secure (permissions, audit, encryption)
- [ ] Agent is useful (does real things for Alex)

---

## Phase 4 Summary

- **Lines of code estimate:** ~3000-3500 (cumulative: ~10,000)
- **Files:** ~25-30 new
- **What works:** A full personal AI agent that runs 24/7, reachable via terminal and Telegram, with scheduled tasks, proactive behavior, persistent memory, and security-first design
- **What's next:** Post-MVP features (multi-user, marketplace, web dashboard, voice, proactive intelligence)
