# Agent Workflow — How Claude Code Works on Mama

## Overview

This document defines how the programming agent (Claude Code) should approach building Mama. It establishes multi-agent patterns, task decomposition, quality standards, and autonomous work guidelines.

**The human (Alex) is the architect and decision maker. The agent is the builder.**

---

## Working Principles

### 1. Read Before You Code

Before starting ANY task:
1. Read this document (AGENTS-WORKFLOW.md)
2. Read MASTER.md for project context
3. Read the relevant architecture doc (ARCHITECTURE.md, MEMORY.md, SECURITY.md, etc.)
4. Read existing code in the affected modules
5. THEN plan and code

### 2. Plan Before You Execute

For any task that involves more than a single file change:
1. Write a brief plan (3-5 bullet points max)
2. Identify dependencies and order of operations
3. Identify what tests are needed
4. Execute the plan step by step
5. Verify each step before moving to the next

### 3. Small, Tested, Complete

Every unit of work should be:
- **Small**: One module, one feature, one fix at a time
- **Tested**: Unit tests for logic, integration tests for interactions
- **Complete**: Working code, not stubs or TODOs (unless explicitly planned for later phase)

### 4. Security First

In every piece of code:
- Never hardcode secrets or API keys
- Always validate inputs (use Zod schemas)
- Always check permissions through the sandbox
- Never trust external input (messages from channels, skill inputs)
- Log security-relevant actions

---

## Multi-Agent Task Decomposition

When a task is complex, it should be decomposed into sub-tasks that can be worked on independently. Think of it as a **task tree**:

```
TASK: Implement Memory Engine
├── SUB-TASK 1: SQLite store setup
│   ├── Create database schema
│   ├── Implement migration system
│   ├── Write store abstraction layer
│   └── Test: CRUD operations work
├── SUB-TASK 2: Episodic memory
│   ├── Implement episode creation
│   ├── Implement embedding generation (Ollama integration)
│   ├── Implement semantic search
│   ├── Implement temporal search
│   └── Test: Store, search, retrieve episodes
├── SUB-TASK 3: Consolidation engine
│   ├── Implement gathering logic
│   ├── Implement LLM consolidation prompt
│   ├── Implement change application
│   ├── Implement decay logic
│   └── Test: Full consolidation cycle
└── SUB-TASK 4: Context retrieval
    ├── Implement retrieval pipeline
    ├── Implement token budget management
    └── Test: Context fits within budget
```

### Rules for Decomposition:

1. **Each sub-task should be independently testable**
2. **Sub-tasks within a level can often be parallelized** (by separate agent instances)
3. **Dependencies flow downward** — higher-level tasks depend on lower-level ones
4. **Each sub-task has clear inputs and outputs**
5. **Each sub-task has acceptance criteria**

---

## Task Execution Protocol

When the agent receives a task, follow this protocol:

### Phase 1: Understand
```
1. Read the task description
2. Read related documentation
3. Read existing code that will be affected
4. Identify questions or ambiguities
5. If critical questions → ask Alex before proceeding
6. If minor ambiguities → make reasonable assumptions, document them
```

### Phase 2: Plan
```
1. Break task into sub-tasks (if complex)
2. Determine execution order (dependencies)
3. Identify files to create/modify
4. Identify tests to write
5. Estimate scope: small (< 100 lines), medium (100-500), large (500+)
6. For large tasks → propose plan to Alex before starting
```

### Phase 3: Implement
```
1. Create/modify files one at a time
2. Follow the code style guide (see below)
3. Write tests alongside implementation
4. Run tests after each significant change
5. If a sub-task is blocked → move to another sub-task, note the blocker
```

### Phase 4: Verify
```
1. Run all tests: pnpm test
2. Run type check: pnpm typecheck
3. Run linter: pnpm lint
4. Manually verify the feature works (if applicable)
5. Review your own changes for:
   - Security issues
   - Error handling
   - Edge cases
   - Code clarity
```

### Phase 5: Report
```
1. Summarize what was done
2. Note any assumptions made
3. Note any remaining TODOs
4. Note any blockers for dependent tasks
```

---

## Code Style Guide

### TypeScript Standards

```typescript
// ✅ DO: Use strict TypeScript
// tsconfig.json: "strict": true

// ✅ DO: Use Zod for runtime validation of external data
import { z } from 'zod';
const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().ip(),
});

// ✅ DO: Use Result type for operations that can fail
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ✅ DO: Prefer explicit error handling over try/catch when possible
async function readFile(path: string): Promise<Result<string>> {
  const permission = await sandbox.check('filesystem', 'read', path);
  if (!permission.allowed) {
    return { ok: false, error: new PermissionError(permission.reason) };
  }
  try {
    const content = await fs.readFile(path, 'utf-8');
    return { ok: true, value: content };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

// ✅ DO: Use descriptive names
// ❌ DON'T: const m = getMemories();
// ✅ DO: const relevantMemories = retrieveMemoriesByQuery(query);

// ✅ DO: Keep functions small (< 50 lines ideally)
// ✅ DO: One export per file for main modules
// ✅ DO: Use barrel exports (index.ts) for directories

// ✅ DO: Document public interfaces
/**
 * Retrieves consolidated memories relevant to the given query.
 * Uses hybrid search (semantic + temporal) with configurable weighting.
 */
async function retrieveContext(query: string, options?: RetrievalOptions): Promise<RetrievedContext>

// ❌ DON'T: Use `any` — use `unknown` and narrow
// ❌ DON'T: Use non-null assertion (!) — handle the null case
// ❌ DON'T: Use default exports (except for config files)
// ❌ DON'T: Use classes unless genuinely needed (prefer functions + interfaces)
// ❌ DON'T: Use enums — use union types or const objects
```

### File Organization

```
// Each module follows this pattern:
src/memory/
├── index.ts           // Public API (barrel export)
├── types.ts           // Interfaces and types
├── store.ts           // Data access layer
├── episodic.ts        // Episodic memory logic
├── consolidated.ts    // Consolidation logic
├── working.ts         // Working memory management
├── soul.ts            // Soul.md management
└── __tests__/         // Tests mirror structure
    ├── store.test.ts
    ├── episodic.test.ts
    └── consolidated.test.ts
```

### Error Handling

```typescript
// Use domain-specific error types
class MamaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean = true
  ) {
    super(message);
    this.name = 'MamaError';
  }
}

class PermissionError extends MamaError {
  constructor(reason: string) {
    super(`Permission denied: ${reason}`, 'PERMISSION_DENIED', true);
  }
}

class LLMError extends MamaError {
  constructor(provider: string, message: string) {
    super(`LLM error (${provider}): ${message}`, 'LLM_ERROR', true);
  }
}
```

### Logging

```typescript
// Use structured logging throughout
import { logger } from '../utils/logger';

logger.info('Memory consolidation started', {
  episodeCount: episodes.length,
  lastConsolidation: lastRun
});

logger.warn('Command required user approval', {
  command: 'git push',
  approved: true,
  approvalTime: 3200 // ms
});

logger.error('LLM call failed', {
  provider: 'claude',
  model: 'claude-sonnet-4-20250514',
  error: err.message,
  retrying: true
});

// Log levels: debug, info, warn, error
// Always include structured context (object as second param)
// Never log secrets, API keys, or full message content
```

---

## Testing Standards

```typescript
// Use vitest
// Naming: describe what the function does, not the test

// ✅ Good
describe('FsCapability', () => {
  it('allows reading files in workspace directory', () => { ... });
  it('denies reading files in .ssh directory', () => { ... });
  it('asks for approval when writing to Documents', () => { ... });
  it('resolves symlinks before checking permissions', () => { ... });
});

// ❌ Bad
describe('tests', () => {
  it('test 1', () => { ... });
  it('should work', () => { ... });
});

// Mock external dependencies (LLM, filesystem)
// Don't mock internal modules (test the real integration)
// Each test should be independent (no shared mutable state)
// Use factories for test data, not hardcoded objects
```

---

## Autonomous Work Guidelines

When the agent is working on longer tasks (multiple hours):

### Checkpoint Strategy
- After completing each sub-task, commit with a clear message
- Use conventional commits: `feat:`, `fix:`, `test:`, `refactor:`, `docs:`
- Never leave the codebase in a broken state between checkpoints

### Decision Making
- **Architectural decisions** → Ask Alex (which database? which framework? which pattern?)
- **Implementation decisions** → Make the call, document why
- **Trade-off decisions** → Document both options, pick the pragmatic one, note the trade-off
- **Security decisions** → Always pick the more secure option

### When to Stop and Ask
- Significant scope change needed
- Security concern discovered
- Two valid architectural approaches with different trade-offs
- External dependency needed that isn't in the approved stack
- Task is significantly larger than estimated

### When to Push Forward
- Implementation details within approved architecture
- Test strategy and coverage decisions
- Code organization within established patterns
- Bug fixes and edge case handling
- Documentation and comments

---

## Commit Conventions

```bash
# Format
type(scope): description

# Types
feat     # New feature
fix      # Bug fix
test     # Adding/updating tests
refactor # Code change that neither fixes a bug nor adds a feature
docs     # Documentation only changes
chore    # Build process, dependencies, tooling

# Scopes (match directories)
core     # Agent runtime
memory   # Memory engine
sandbox  # Capability sandbox
scheduler # Cron/heartbeat
llm      # LLM router
channels # Terminal/Telegram/API
skills   # Skill system
config   # Configuration

# Examples
feat(memory): implement episodic memory storage and semantic search
feat(sandbox): add filesystem capability with path-based permissions
fix(llm): handle Claude API timeout with Ollama fallback
test(memory): add consolidation cycle integration tests
refactor(core): extract planning logic into separate module
docs(security): document threat model and mitigations
```

---

## Definition of Done

A task is DONE when:

1. ✅ Code is implemented and working
2. ✅ Types are strict (no `any`, no `as` casts without justification)
3. ✅ Tests exist and pass
4. ✅ Linter passes with no warnings
5. ✅ Type checker passes
6. ✅ Security reviewed (permissions, input validation, no secrets)
7. ✅ Error cases handled (not just happy path)
8. ✅ Logging added for important operations
9. ✅ Code is documented (public APIs have JSDoc)
10. ✅ Committed with proper commit message
