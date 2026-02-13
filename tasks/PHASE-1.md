# Phase 1: Foundation — Detailed Tasks

## Prerequisites
- Node.js 22+ installed
- pnpm installed
- Ollama installed and running locally
- Claude API key available
- Git initialized

---

## Task 1.1: Project Scaffolding

**Priority:** P0 — Everything depends on this
**Estimated effort:** 30 min

### Steps:
1. Initialize project with `pnpm init`
2. Install core dependencies:
   ```
   pnpm add typescript zod yaml better-sqlite3 commander ink ink-text-input react
   pnpm add -D @types/node @types/better-sqlite3 tsup vitest biome @biomejs/biome tsx
   ```
3. Create `tsconfig.json` (strict mode, ES2022, NodeNext module)
4. Create `biome.json` (formatting + linting config)
5. Create `tsup.config.ts` (build config — single entry, bundle for node)
6. Create `vitest.config.ts`
7. Create directory structure as specified in MASTER.md
8. Create `package.json` scripts:
   - `dev`: `tsx watch src/index.ts`
   - `build`: `tsup`
   - `start`: `node dist/index.js`
   - `test`: `vitest`
   - `test:run`: `vitest run`
   - `typecheck`: `tsc --noEmit`
   - `lint`: `biome check src/`
   - `lint:fix`: `biome check --apply src/`
9. Create initial `src/index.ts` with hello world
10. Verify: `pnpm dev` runs, `pnpm test` passes, `pnpm build` produces output

### Acceptance criteria:
- All scripts work
- TypeScript strict mode active
- Biome configured and passing
- Directory structure matches MASTER.md

---

## Task 1.2: Configuration System

**Priority:** P0
**Depends on:** 1.1
**Estimated effort:** 1 hour

### Steps:
1. Create `src/config/schema.ts`:
   - Define Zod schemas for all config sections
   - Schema for: agent, user, llm (providers, routing), channels, sandbox, scheduler, memory, logging
   - Export typed config type: `type MamaConfig = z.infer<typeof ConfigSchema>`

2. Create `src/config/defaults.ts`:
   - Sensible defaults for all config values
   - Default paths based on platform (XDG on Linux, ~/Library on macOS)
   - MAMA_HOME env var override

3. Create `src/config/loader.ts`:
   - Load from `~/.mama/config.yaml` (or MAMA_HOME)
   - Merge with defaults (deep merge)
   - Validate with Zod
   - Support env var references in config (`${MAMA_CLAUDE_API_KEY}`)
   - Export singleton: `getConfig(): MamaConfig`

4. Create `src/config/index.ts` (barrel export)

5. Create `templates/config.default.yaml` (commented template)

6. Tests:
   - Config loads and validates correctly
   - Missing optional fields use defaults
   - Invalid config throws descriptive error
   - Env var substitution works

### Acceptance criteria:
- Config loads from YAML, validates with Zod, merges with defaults
- Error messages are helpful when config is invalid
- Env vars are resolved

---

## Task 1.3: Logging System

**Priority:** P0
**Depends on:** 1.2
**Estimated effort:** 30 min

### Steps:
1. Create `src/utils/logger.ts`:
   - Simple structured logger (no heavy deps)
   - Levels: debug, info, warn, error
   - Output: JSON lines to file + pretty print to stderr
   - Configurable level from config
   - Context injection (add default fields like timestamp, module)

2. Export: `createLogger(module: string): Logger`

3. Tests:
   - Logs at correct levels
   - Filters by configured level
   - Structured output is valid JSON

---

## Task 1.4: LLM Router

**Priority:** P0
**Depends on:** 1.2, 1.3
**Estimated effort:** 2 hours

### Steps:
1. Create `src/llm/types.ts`:
   - `LLMRequest` interface (system, messages, tools, model, temperature, maxTokens)
   - `LLMResponse` interface (content, toolCalls, usage)
   - `Message` type (role, content, toolCalls, toolResults)
   - `ToolDefinition` interface (name, description, parameters as JSON Schema)
   - `ToolCall` interface (id, name, arguments)

2. Create `src/llm/providers/claude.ts`:
   - Uses `@anthropic-ai/sdk`
   - Implements: `complete(request: LLMRequest): Promise<LLMResponse>`
   - Handles: tool_use responses, streaming (optional for MVP)
   - Error handling: timeout, rate limit, auth error

3. Create `src/llm/providers/ollama.ts`:
   - Uses `ollama` npm package
   - Same interface as Claude provider
   - Handles: tool calling (if model supports it), fallback to text-only
   - Embedding support: `embed(text: string): Promise<Float32Array>`

4. Create `src/llm/router.ts`:
   - Takes task type → returns best provider + model
   - Routing rules from config (llm.routing)
   - Fallback logic: if primary fails, try secondary
   - Cost tracking: record every call

5. Create `src/llm/cost-tracker.ts`:
   - Track input/output tokens per call
   - Calculate cost based on model pricing
   - Store in memory (Phase 3 will persist to SQLite)
   - `getUsageToday()`, `getUsageThisMonth()`, `getTotalCost()`

6. Create `src/llm/index.ts` (barrel export)

7. Tests:
   - Claude provider formats requests correctly (mock HTTP)
   - Ollama provider formats requests correctly (mock HTTP)
   - Router selects correct provider based on task type
   - Fallback works when primary fails
   - Cost tracking accumulates correctly

### Acceptance criteria:
- Can send messages to Claude and get responses
- Can send messages to Ollama and get responses
- Router picks the right model based on task type
- Fallback switches provider on failure
- Cost is tracked per call

---

## Task 1.5: Working Memory (Context Window Manager)

**Priority:** P0
**Depends on:** 1.4
**Estimated effort:** 1 hour

### Steps:
1. Create `src/memory/working.ts`:
   - Manages the messages array sent to LLM
   - Token counting (use tiktoken or simple word-based estimation)
   - Progressive summarization: when approaching limit, summarize oldest messages
   - Injects: system prompt + soul.md + relevant memories placeholder
   - Methods:
     - `addMessage(msg: Message): void`
     - `getMessages(): Message[]`
     - `getTokenCount(): number`
     - `compress(): Promise<void>` (summarize old messages)
     - `clear(): void`

2. Create `src/memory/soul.ts`:
   - Load SOUL.md from `~/.mama/soul.md`
   - Parse sections (identity, personality, knowledge, goals, boundaries)
   - Provide as string for system prompt injection
   - Method: `getSoulPrompt(): string`

3. Create `templates/SOUL.md`:
   - Default soul template with placeholder sections

4. Tests:
   - Token counting works approximately correctly
   - Compression triggers at threshold
   - Soul loads and provides formatted prompt

---

## Task 1.6: Agent Core (Basic ReAct — No Tools Yet)

**Priority:** P0
**Depends on:** 1.4, 1.5
**Estimated effort:** 2 hours

### Steps:
1. Create `src/core/agent.ts`:
   - Main agent class/function
   - `processMessage(input: string, channel: string): Promise<string>`
   - Builds system prompt from soul + working memory
   - Sends to LLM router
   - Returns response text
   - Stores messages in working memory

2. Create `src/core/context.ts`:
   - `buildSystemPrompt(soul: string, memories: string[]): string`
   - Assembles the full system prompt with all context sections

3. Create `src/core/types.ts`:
   - Core types used across the agent

4. Create `src/core/index.ts` (barrel export)

5. Tests:
   - Agent processes a message and returns a response
   - System prompt includes soul content
   - Working memory accumulates messages
   - Context management prevents overflow

### Acceptance criteria:
- Agent can receive text input and produce text output
- Conversation history is maintained within session
- System prompt is well-structured

---

## Task 1.7: Terminal Channel

**Priority:** P0
**Depends on:** 1.6
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/channels/terminal.ts`:
   - Use Ink (React for CLI) for rich terminal UI
   - Components:
     - Header: "🤱 Mama" + status indicators
     - Chat area: scrollable message history
     - Input: text input with submit
     - Status bar: model in use, token count, cost today
   - Connect to agent: on input → agent.processMessage → display response
   - Handle: Ctrl+C gracefully, clear screen, history scrollback

2. Create `src/channels/types.ts`:
   - Channel interface (send, onMessage, start, stop)

3. Create `src/channels/index.ts` (barrel export)

4. Update `src/index.ts`:
   - Parse CLI args with commander
   - Commands: `mama chat` (default), `mama --version`, `mama --help`
   - Initialize config, logger, LLM router, agent, terminal channel
   - Start terminal channel

5. Tests:
   - Terminal channel implements Channel interface
   - Messages flow from input to agent to output

### Acceptance criteria:
- `pnpm dev` launches interactive terminal chat
- User can type messages and receive responses
- Status bar shows current model and token usage
- Ctrl+C exits cleanly

---

## Task 1.8: Integration Test

**Priority:** P0
**Depends on:** All above
**Estimated effort:** 30 min

### Steps:
1. Create integration test that:
   - Loads config from test fixture
   - Initializes agent with mocked LLM
   - Sends a series of messages
   - Verifies responses are generated
   - Verifies working memory grows
   - Verifies context doesn't exceed limits

2. Manual test checklist:
   - [ ] `pnpm dev` starts Mama
   - [ ] Can chat naturally
   - [ ] Claude handles complex questions
   - [ ] Ollama handles simple questions (if configured)
   - [ ] Config validation catches errors
   - [ ] Ctrl+C exits cleanly

### Acceptance criteria:
- All unit tests pass
- Integration test passes
- Manual checklist complete
- No TypeScript errors
- Biome passes

---

## Phase 1 Summary

After completing all tasks:
- **Lines of code estimate:** ~1500-2000
- **Files:** ~25-30
- **What works:** Chat with an AI agent in the terminal, smart model routing, context management
- **What's next:** Phase 2 adds the capability sandbox (the agent gets hands)
