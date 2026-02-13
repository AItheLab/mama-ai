# Phase 2: Hands — Detailed Tasks

## Prerequisites
- Phase 1 complete and passing
- Agent can chat in terminal

---

## Task 2.1: Capability Framework

**Priority:** P0
**Estimated effort:** 2 hours

### Steps:
1. Create `src/sandbox/types.ts`:
   - `Capability` interface
   - `Permission`, `PermissionRequest`, `PermissionDecision` types
   - `CapabilityResult` with audit entry
   - `AuditEntry` interface

2. Create `src/sandbox/sandbox.ts`:
   - Central sandbox manager
   - Registers capabilities
   - Routes permission checks to correct capability
   - Methods:
     - `register(capability: Capability): void`
     - `check(capName, action, resource): PermissionDecision`
     - `execute(capName, action, params): Promise<CapabilityResult>`

3. Create `src/sandbox/approval.ts`:
   - `requestApproval(request: ApprovalRequest): Promise<boolean>`
   - Sends approval request to active channel
   - Waits for response with timeout
   - Returns approved/denied

4. Tests:
   - Sandbox routes to correct capability
   - Unknown capability throws error
   - Approval flow works with mock channel

---

## Task 2.2: Audit Log

**Priority:** P0
**Depends on:** 2.1
**Estimated effort:** 1 hour

### Steps:
1. Create `src/sandbox/audit.ts`:
   - Initialize SQLite table for audit_log (see ARCHITECTURE.md schema)
   - `log(entry: AuditEntry): void` — append-only insert
   - `query(filters: AuditFilters): AuditEntry[]` — search by capability, action, time, result
   - `getRecent(limit: number): AuditEntry[]`
   - WAL mode for crash safety

2. Add CLI command: `mama audit [--last N] [--capability X] [--action Y]`

3. Tests:
   - Entries are stored correctly
   - Queries filter correctly
   - Log is append-only (no update/delete methods)

---

## Task 2.3: Filesystem Capability

**Priority:** P0
**Depends on:** 2.1, 2.2
**Estimated effort:** 2 hours

### Steps:
1. Create `src/sandbox/fs-cap.ts`:
   - Implement `Capability` interface
   - Permission rules from config (sandbox.filesystem)
   - Path resolution (absolute, symlink following, traversal detection)
   - Glob matching with micromatch
   - Actions: read, write, list, delete, move, copy, search
   - Each action creates an audit entry

2. Install: `pnpm add micromatch`; `pnpm add -D @types/micromatch`

3. Tests:
   - Workspace access always allowed
   - Denied paths always blocked
   - Ask-level paths trigger approval
   - Symlink traversal detected
   - Path traversal (`../`) detected
   - Glob patterns match correctly

---

## Task 2.4: Shell Capability

**Priority:** P0
**Depends on:** 2.1, 2.2
**Estimated effort:** 2 hours

### Steps:
1. Create `src/sandbox/shell-cap.ts`:
   - Command parsing (split pipes, chains, semicolons)
   - Three-tier classification (safe/ask/denied)
   - Pattern matching for denied commands
   - Execution with:
     - Timeout (configurable, default 30s)
     - Working directory restriction
     - Environment sanitization
     - Output capture with size limit (1MB)
     - Separate stdout/stderr capture
   - Each execution creates audit entry

2. Use `child_process.execFile` or `child_process.spawn` (not `exec` — avoid shell injection)

3. Tests:
   - Safe commands execute without approval
   - Ask commands trigger approval
   - Denied commands are blocked
   - Piped commands: each segment checked
   - Timeout kills long-running commands
   - Output captured correctly

---

## Task 2.5: Network Capability

**Priority:** P0
**Depends on:** 2.1, 2.2
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/sandbox/network-cap.ts`:
   - Domain extraction from URL
   - Whitelist/blacklist checking
   - Session-based approvals (in-memory)
   - Persistent approvals (saved to config)
   - Rate limiting (per minute/per hour)
   - Request logging (URL, method, status — NOT response body)
   - Uses native `fetch` (Node 22+)
   - Audit entry for each request

2. Tests:
   - Allowed domains pass immediately
   - Denied domains are blocked
   - Unknown domains trigger approval
   - Rate limiting enforced
   - Request logging works

---

## Task 2.6: Tool Definitions

**Priority:** P0
**Depends on:** 2.3, 2.4, 2.5
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/core/tools/types.ts`:
   - `Tool` interface (name, description, parameters as Zod schema, execute function)
   - `ToolResult` type

2. Create `src/core/tools/fs-tools.ts`:
   - `read_file`: Read file contents
   - `write_file`: Write/create a file
   - `list_directory`: List directory contents
   - `search_files`: Search for files by name/pattern
   - `move_file`: Move/rename a file

3. Create `src/core/tools/shell-tools.ts`:
   - `execute_command`: Run a shell command

4. Create `src/core/tools/network-tools.ts`:
   - `http_request`: Make HTTP request (GET, POST, etc.)

5. Create `src/core/tools/meta-tools.ts`:
   - `ask_user`: Ask the user a clarifying question
   - `report_progress`: Report progress on multi-step tasks

6. Create `src/core/tools/index.ts`:
   - Registry of all available tools
   - `getToolDefinitions(): ToolDefinition[]` — format for LLM

7. Each tool:
   - Validates params with Zod
   - Routes through sandbox
   - Returns structured result

8. Tests:
   - Each tool validates parameters correctly
   - Tools route through sandbox (permission checks happen)
   - Tool definitions format correctly for LLM

---

## Task 2.7: Agent Loop Upgrade — Tool Use

**Priority:** P0
**Depends on:** 2.6
**Estimated effort:** 2 hours

### Steps:
1. Update `src/core/agent.ts`:
   - Include tool definitions in LLM requests
   - Handle tool_use responses from LLM
   - Execute tool calls through sandbox
   - Feed results back to LLM
   - Loop until LLM produces final text response
   - Max iterations safety (prevent infinite loops, default: 10)

2. Create `src/core/planner.ts`:
   - For multi-step tasks, create explicit plan
   - Plan confirmation flow (show plan to user, wait for approval)
   - Plan execution with step tracking

3. Create `src/core/executor.ts`:
   - Execute individual plan steps
   - Handle step failures (retry, fallback, abort)
   - Progress reporting

4. Update terminal channel:
   - Show tool execution in real-time (what Mama is doing)
   - Show approval prompts inline
   - Show plan before execution (for side-effect plans)

5. Tests:
   - Agent can use tools to answer questions
   - Multi-step plans are created and executed
   - Failed steps handled correctly
   - Max iterations prevents infinite loops
   - Approval flow works for protected operations

---

## Task 2.8: Integration Test

**Priority:** P0
**Depends on:** All above

### Test scenarios:
1. "List the files in my workspace" → uses list_directory, auto-approved
2. "Create a file called test.md with content 'Hello'" → uses write_file in workspace, auto-approved
3. "Read my SSH key" → denied by sandbox, agent reports denial
4. "Run ls -la in my home directory" → shell, auto-approved
5. "Delete all files in /tmp" → denied by sandbox
6. "What's my git status in ~/Projects/mama?" → shell, auto-approved
7. Multi-step: "Create a directory, write a file, then list it" → plan, execute, report

---

## Phase 2 Summary

- **Lines of code estimate:** ~2000-2500 (cumulative: ~4000)
- **Files:** ~15-20 new
- **What works:** Agent can read files, execute commands, make HTTP requests — all through a secure sandbox with audit logging
- **What's next:** Phase 3 adds persistent memory (the agent gets a brain)
