# Mama: Operations and Deployment Guide (24/7)

This document is the production runbook for installing, configuring, securing, and operating Mama in a 24/7 environment.

## 1) Scope

This guide covers:

- Installation from source
- Runtime requirements and supported environments
- Full configuration reference for production usage
- Daemon/service setup on Linux and macOS
- Telegram and local API operation
- Scheduler, heartbeat, and trigger automation
- Security model and hardening checklist
- Monitoring, backups, and troubleshooting
- Safe start/stop procedures and background process verification

## 2) Compatibility and Requirements

### Required

- Node.js: `22.x LTS` (recommended and supported baseline)
- pnpm: `10.x`
- OS: Linux or macOS

### Optional (by feature)

- Ollama runtime/API access (for LLM calls via `ollama` provider)
- Telegram bot token (Telegram channel)

### Important compatibility note

`package.json` declares `node >=22 <25`.

- Node 25 may still run but is not the target environment.
- For 24/7 production stability, run Node 22 LTS.

## 3) Runtime Architecture (What Runs in Production)

When running in daemon mode (`mama daemon`), Mama can run:

- Core agent
- Sandbox capabilities:
  - filesystem
  - shell
  - network
- Scheduler (cron jobs)
- Heartbeat loop
- Trigger engine:
  - file watchers
  - webhook listener
- Telegram channel (optional)
- Local API channel (optional)

State and data are stored under `MAMA_HOME` (default `~/.mama`).

## 4) Data and File Layout

By default (`MAMA_HOME=~/.mama`):

- `~/.mama/config.yaml` - runtime config
- `~/.mama/mama.db` - main SQLite DB (memory, jobs, usage, skills, audit table schema)
- `~/.mama/soul.md` - soul prompt state
- `~/.mama/heartbeat.md` - heartbeat checklist
- `~/.mama/workspace/` - agent workspace
- `~/.mama/notes/` - notes folder
- `~/.mama/skills/` - installed skills
- `~/.mama/logs/mama.log` - main log file
- `~/.mama/mama.pid` - daemon PID file

## 5) Installation from Source (Recommended)

From project root:

```bash
pnpm install
pnpm build
```

Then initialize:

```bash
node dist/index.js init --yes --force --name "YourName"
```

The build step also copies required runtime assets into `dist/`:

- `dist/migrations`
- `dist/built-in`

Without these assets, daemon startup will fail.

## 6) CLI Usage Reference

Main commands:

```bash
node dist/index.js chat
node dist/index.js daemon
node dist/index.js memory
node dist/index.js jobs
node dist/index.js cost
node dist/index.js init
```

Daemon subcommands:

```bash
node dist/index.js daemon start
node dist/index.js daemon stop
node dist/index.js daemon status
node dist/index.js daemon logs -n 200
```

Scheduler job operations:

```bash
node dist/index.js jobs list
node dist/index.js jobs create "*/30 * * * *" "Summarize workspace changes"
node dist/index.js jobs enable <job-id>
node dist/index.js jobs disable <job-id>
node dist/index.js jobs delete <job-id>
```

Memory operations:

```bash
node dist/index.js memory search "release notes"
node dist/index.js memory list
node dist/index.js memory stats
node dist/index.js memory consolidate
node dist/index.js memory forget <memory-id>
```

Cost dashboard:

```bash
node dist/index.js cost --period today
node dist/index.js cost --period week
node dist/index.js cost --period month
node dist/index.js cost --period all
```

## 7) Configuration for Production

Default template: `templates/config.default.yaml`  
Runtime file: `~/.mama/config.yaml` (or custom path with `--config`)

### Config loading behavior

- YAML keys can be snake_case; loader maps to internal camelCase.
- Environment variables are supported via `${ENV_VAR}` syntax.
- If an env var is missing, it resolves to empty string.

### Example production config

```yaml
version: 1

agent:
  name: "Mama"
  soul_path: "~/.mama/soul.md"

user:
  name: "Alex"
  telegram_ids: [123456789]
  timezone: "Europe/Madrid"
  locale: "es-ES"

llm:
  default_provider: "ollama"
  providers:
    ollama:
      host: "http://localhost:11434"
      api_key: "${OLLAMA_API_KEY}"
      default_model: "minimax-m2.5:cloud"
      smart_model: "minimax-m2.5:cloud"
      fast_model: "gemini-3-flash-preview:cloud"
      embedding_model: "nomic-embed-text"
    claude:
      api_key: "${CLAUDE_API_KEY}"
      default_model: "claude-sonnet-4-20250514"
      max_monthly_budget_usd: 50
  routing:
    complex_reasoning: "ollama"
    code_generation: "ollama"
    simple_tasks: "ollama"
    embeddings: "ollama"
    memory_consolidation: "ollama"
    private_content: "ollama"

channels:
  terminal:
    enabled: false
  telegram:
    enabled: true
    bot_token: "${MAMA_TELEGRAM_TOKEN}"
    default_chat_id: 123456789
  api:
    enabled: true
    host: "127.0.0.1"
    port: 3377
    token: "${MAMA_API_TOKEN}"

sandbox:
  filesystem:
    workspace: "~/.mama/workspace"
    allowed_paths:
      - path: "~/.mama/**"
        actions: ["read", "write", "list"]
        level: "auto"
    denied_paths:
      - "~/.ssh/**"
      - "~/.gnupg/**"
  shell:
    safe_commands: ["ls", "cat", "head", "tail", "grep", "find", "wc", "date", "whoami", "pwd", "echo"]
    ask_commands: ["git commit", "git push", "mkdir", "cp", "mv", "pnpm", "node"]
    denied_patterns: ["rm -rf", "sudo", "curl | bash", "wget | sh", "chmod 777", "mkfs"]
  network:
    allowed_domains: ["ollama.com", "api.telegram.org", "localhost", "api.github.com"]
    ask_domains: true
    rate_limit_per_minute: 30
    log_all_requests: true

scheduler:
  heartbeat:
    enabled: true
    interval_minutes: 30
    heartbeat_file: "~/.mama/heartbeat.md"
  max_concurrent_jobs: 3
  triggers:
    file_watchers:
      - path: "~/.mama/workspace"
        events: ["change", "add"]
        task: "A file changed at {path}/{filename} (event: {event}). Summarize and propose next actions."
    webhooks:
      enabled: true
      host: "127.0.0.1"
      port: 3378
      hooks:
        - id: "deploy"
          token: "${MAMA_WEBHOOK_DEPLOY_TOKEN}"
          task: "Webhook deploy event payload: {payload}. Analyze impact and suggest response."

daemon:
  pid_file: "~/.mama/mama.pid"
  health_check_interval_seconds: 30

memory:
  consolidation:
    enabled: true
    interval_hours: 6
    min_episodes_to_consolidate: 10
    model: "ollama"
  max_episodic_entries: 100000
  embedding_dimensions: 768
  search_top_k: 10

logging:
  level: "info"
  file: "~/.mama/logs/mama.log"
  max_size_mb: 50
  rotate: true
```

## 8) 24/7 Service Deployment

### Linux (systemd)

Use absolute paths to avoid PATH issues:

`/etc/systemd/system/mama.service`

```ini
[Unit]
Description=Mama AI Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mama
ExecStart=/usr/bin/node /opt/mama/dist/index.js daemon --foreground
Restart=on-failure
RestartSec=5
User=mama
Environment=MAMA_HOME=/home/mama/.mama
Environment=OLLAMA_API_KEY=...
Environment=MAMA_TELEGRAM_TOKEN=...
Environment=MAMA_API_TOKEN=...

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mama
sudo systemctl status mama
```

### macOS (launchd)

Use `~/Library/LaunchAgents/com.mama.agent.plist` with absolute paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mama.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/Users/alex/Desktop/Mama/dist/index.js</string>
    <string>daemon</string>
    <string>--foreground</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/alex/Desktop/Mama</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/alex/.mama/logs/mama.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/alex/.mama/logs/mama.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MAMA_HOME</key>
    <string>/Users/alex/.mama</string>
  </dict>
</dict>
</plist>
```

Load:

```bash
launchctl load -w ~/Library/LaunchAgents/com.mama.agent.plist
launchctl list | grep mama
```

## 9) Channel Operations

### Telegram channel

Requirements:

- `channels.telegram.enabled: true`
- valid `bot_token`
- `user.telegram_ids` contains authorized numeric user IDs

Supported message types:

- text
- document upload (stored in workspace, then processed by agent)
- voice: currently returns unsupported notice

Telegram commands:

- `/status`
- `/jobs`
- `/audit`
- `/cost`
- `/memory <query>`

Approval flow:

- For actions requiring user approval, Telegram shows inline buttons:
  - Approve
  - Deny
  - Always (store allow rule for same capability/action/resource key)
- Approval timeout: 5 minutes.

### Local API channel

Requirements:

- `channels.api.enabled: true`
- bind host is localhost (`127.0.0.1` or `localhost`)
- bearer token in `channels.api.token` (recommended; if empty, random token is generated in-process)

Endpoints:

- `POST /api/message`
- `GET /api/status`
- `GET /api/jobs`
- `POST /api/jobs`
- `GET /api/audit?limit=20`
- `GET /api/memory/search?q=...`
- `GET /api/cost`

Example:

```bash
curl -sS \
  -H "Authorization: Bearer $MAMA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Give me a short status summary"}' \
  http://127.0.0.1:3377/api/message
```

## 10) Scheduler, Heartbeat, and Triggers

### Jobs

- Cron expressions are accepted directly.
- Natural language schedules are attempted via LLM parser first.
- If parser fails, built-in fallback supports forms like:
  - `every minute`
  - `every 30 minutes`
  - `every 2 hours`
  - `every day at 09:30`
  - `every monday at 10:00`

### Heartbeat

Heartbeat periodically reads `heartbeat_file` and system state (uptime, memory, loadavg), then runs an agent task.

If checklist file is missing, heartbeat uses a fallback prompt indicating checklist absence.

### Trigger engine

File watchers:

- Configured per path/events/task template
- Template placeholders:
  - `{filename}`
  - `{event}`
  - `{path}`

Webhook triggers:

- Endpoint format: `POST /hooks/<hook-id>`
- Auth header: `Authorization: Bearer <hook-token>`
- Task template supports `{payload}` placeholder.

Example:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $MAMA_WEBHOOK_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"service":"api","status":"degraded","error_rate":0.12}' \
  http://127.0.0.1:3378/hooks/deploy
```

## 11) Security Model

All side-effectful operations route through sandbox capabilities.

### Filesystem capability

Decision order:

1. Denied paths (hard deny)
2. Workspace path (auto allow)
3. Allowed path rules (auto or ask)
4. Default deny

Additional protections:

- Tilde expansion safety
- realpath resolution checks
- basic traversal detection
- output truncation in audit

### Shell capability

Commands are segmented (`|`, `;`, `&&`, `||`) and each segment is classified:

- `denied` -> block
- `safe` -> auto-approve
- `ask` -> requires explicit user approval token
- `unknown` -> treated as ask

Compound commands always require approval unless denied first.

### Network capability

- Domain allowlist + optional ask mode for unknown domains
- Per-minute rate limiting
- Session domain approvals after successful user-approved request

### API security

- API channel only binds localhost
- Bearer token required for all endpoints

### Telegram security

- Strict user ID allowlist
- Interactive approval with timeout

## 12) Production Hardening Checklist

- Use Node 22 LTS
- Run Mama under dedicated OS user (non-root)
- Restrict file permissions:
  - `~/.mama/config.yaml` should be readable only by service user
- Keep API bound to localhost; expose externally only behind trusted reverse proxy
- Use long random tokens for API and webhooks
- Keep `denied_paths` for sensitive directories (`~/.ssh`, `~/.gnupg`, credentials stores)
- Keep dangerous shell patterns denied
- Minimize `allowed_domains`
- Enable centralized log collection for `~/.mama/logs/mama.log`
- Backup `~/.mama` regularly (or `MAMA_HOME`)

## 13) Observability and Routine Operations

Core checks:

```bash
node dist/index.js daemon status
node dist/index.js daemon logs -n 200
node dist/index.js jobs list
node dist/index.js memory stats
node dist/index.js cost --period today
```

If API is enabled:

```bash
curl -sS -H "Authorization: Bearer $MAMA_API_TOKEN" http://127.0.0.1:3377/api/status
curl -sS -H "Authorization: Bearer $MAMA_API_TOKEN" "http://127.0.0.1:3377/api/audit?limit=20"
```

## 14) Backups and Restore

### Backup

1. Stop daemon
2. Archive `MAMA_HOME`

```bash
node dist/index.js daemon stop
tar -czf mama-backup-$(date +%F-%H%M%S).tar.gz ~/.mama
```

### Restore

1. Stop daemon
2. Restore archive to intended `MAMA_HOME`
3. Start daemon

```bash
node dist/index.js daemon stop
tar -xzf mama-backup-YYYY-MM-DD-HHMMSS.tar.gz -C ~
node dist/index.js daemon start
```

## 15) Upgrade and Rollback

### Upgrade (source deployment)

```bash
git pull
pnpm install
pnpm build
pnpm typecheck
pnpm test:run
pnpm lint
node dist/index.js daemon stop
node dist/index.js daemon start
```

### Rollback

- Revert to previous commit/release
- Rebuild
- Restore backup if schema/data rollback is needed
- Start daemon and validate status/logs

## 16) Troubleshooting

### `mama: command not found`

Use direct runtime command:

```bash
node /absolute/path/to/dist/index.js <command>
```

Or install/link global binary.

### `ERR_MODULE_NOT_FOUND` for `sqlite` in `dist/index.js`

Cause: stale/broken build artifact.

Fix:

```bash
pnpm build
```

Verify `dist/index.js` contains `nodeRequire("node:sqlite")`.

### Daemon exits immediately

Check logs:

```bash
node dist/index.js daemon logs -n 200
```

If you see missing runtime assets (migrations/built-ins), rebuild:

```bash
pnpm build
```

### Telegram not responding

Verify:

- `channels.telegram.enabled` is true
- valid token
- your numeric Telegram user ID is in `user.telegram_ids`

### API returns 401

- Missing or wrong bearer token.
- Check `channels.api.token` and request header.

### Status says running but process is dead

Stale PID file. Stop and start:

```bash
node dist/index.js daemon stop
node dist/index.js daemon start
```

## 17) Start/Stop Runbook (No Orphan Background Processes)

### Start

```bash
node dist/index.js daemon start
node dist/index.js daemon status
```

Expected: `running (pid <n>)`

### Stop

```bash
node dist/index.js daemon stop
node dist/index.js daemon status
```

Expected: `not running`

### Extra verification (optional)

```bash
PID_FILE=~/.mama/mama.pid
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  ps -p "$PID" -o pid,ppid,etime,command
fi

lsof -iTCP:3377 -sTCP:LISTEN 2>/dev/null || true
lsof -iTCP:3378 -sTCP:LISTEN 2>/dev/null || true
```

If nothing is listening and daemon status is `not running`, no Mama background service is active.
