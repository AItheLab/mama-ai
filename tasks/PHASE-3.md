# Phase 3: Brain — Detailed Tasks

## Prerequisites
- Phase 2 complete
- Agent can act through sandbox
- SQLite already used for audit log (extend for memory)

---

## Task 3.1: Database Schema & Migration

**Priority:** P0
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/memory/store.ts`:
   - Initialize SQLite database at `~/.mama/mama.db`
   - Create all tables (episodes, memories, audit_log, jobs, llm_usage, skills)
   - Migration system: version-tracked schema changes
   - WAL mode, foreign keys enabled
   - Connection pool (better-sqlite3 is synchronous, but manage single instance)

2. Install: `pnpm add sqlite-vec` (for vector search extension)

3. Create `src/memory/migrations/`:
   - `001_initial.sql`: All tables from ARCHITECTURE.md
   - Migration runner: track applied migrations in `_migrations` table

4. Tests:
   - Database creates successfully
   - Migrations apply in order
   - Schema matches specification

---

## Task 3.2: Episodic Memory

**Priority:** P0
**Depends on:** 3.1
**Estimated effort:** 2 hours

### Steps:
1. Create `src/memory/episodic.ts`:
   - `storeEpisode(episode: Omit<Episode, 'id' | 'embedding'>): Promise<string>`
     - Generate UUID
     - Generate embedding via Ollama
     - Store with metadata
   - `searchSemantic(query: string, options?: SearchOptions): Promise<Episode[]>`
     - Embed query
     - Vector similarity search via sqlite-vec
     - Return top-k results
   - `searchTemporal(start: Date, end: Date): Promise<Episode[]>`
   - `searchHybrid(query: string, options?: HybridOptions): Promise<Episode[]>`
     - Combine semantic + temporal + topic scoring
   - `getRecent(limit: number): Promise<Episode[]>`
   - `markConsolidated(ids: string[]): Promise<void>`

2. Create `src/memory/embeddings.ts`:
   - `embed(text: string): Promise<Float32Array>`
   - `embedBatch(texts: string[]): Promise<Float32Array[]>`
   - Uses Ollama with nomic-embed-text model
   - Caching: don't re-embed identical text

3. Update agent to store every interaction as episode:
   - User messages, agent responses, tool executions, system events
   - Extract metadata: topics, entities, importance, emotional tone

4. Tests:
   - Episodes store and retrieve correctly
   - Semantic search returns relevant results
   - Temporal search filters by date
   - Hybrid search combines both signals
   - Embeddings generated correctly

---

## Task 3.3: Consolidated Memory Store

**Priority:** P0
**Depends on:** 3.1
**Estimated effort:** 1 hour

### Steps:
1. Create `src/memory/consolidated.ts` (store operations only):
   - `create(memory: NewConsolidatedMemory): Promise<string>`
   - `update(id: string, changes: Partial<ConsolidatedMemory>): Promise<void>`
   - `reinforce(id: string): Promise<void>` — increment counter, update timestamp
   - `deactivate(id: string): Promise<void>` — soft delete
   - `reactivate(id: string): Promise<void>`
   - `search(query: string, options?: SearchOptions): Promise<ConsolidatedMemory[]>`
   - `getByCategory(category: MemoryCategory): Promise<ConsolidatedMemory[]>`
   - `getActive(minConfidence?: number): Promise<ConsolidatedMemory[]>`

2. Tests:
   - CRUD operations work correctly
   - Reinforce increments correctly
   - Deactivate/reactivate toggle works
   - Search returns relevant results

---

## Task 3.4: Sleep Time Consolidation Engine

**Priority:** P0 — This is the key differentiator
**Depends on:** 3.2, 3.3
**Estimated effort:** 3 hours

### Steps:
1. Create `src/memory/consolidation.ts`:
   - `runConsolidation(): Promise<ConsolidationReport>`
   - Gather unconsolidated episodes (batch of 50-100)
   - Load existing consolidated memories
   - Build consolidation prompt (see MEMORY.md)
   - Send to LLM (Claude, configurable)
   - Parse LLM response (new, reinforce, update, contradict, decay, connect)
   - Apply changes in a transaction
   - Generate report

2. Create `src/memory/decay.ts`:
   - `runDecay(): Promise<DecayReport>`
   - Reduce confidence of unreinforced memories
   - Deactivate memories below threshold
   - Run as part of consolidation or separately

3. Consolidation scheduling:
   - Configurable interval (default: every 6 hours)
   - Minimum episodes threshold (default: 10 new episodes)
   - Runs when agent is idle (no active conversation)

4. Create `src/memory/soul.ts` (update existing):
   - After consolidation, regenerate soul.md sections:
     - Knowledge section from facts + skills
     - Goals section from active goals
     - Preferences from preference memories
   - Keep the static sections (identity, personality, boundaries)
   - Write updated soul.md to disk

5. Tests:
   - Consolidation prompt is well-formed
   - LLM response is parsed correctly (mock LLM)
   - New memories are created with correct fields
   - Existing memories are reinforced/updated/decayed
   - Contradictions are flagged
   - Soul.md is updated after consolidation
   - Decay reduces confidence correctly
   - Below-threshold memories are deactivated

---

## Task 3.5: Memory Retrieval Pipeline

**Priority:** P0
**Depends on:** 3.2, 3.3
**Estimated effort:** 1.5 hours

### Steps:
1. Create `src/memory/retrieval.ts`:
   - `retrieveContext(query: string, tokenBudget: number): Promise<RetrievedContext>`
   - Steps:
     1. Semantic search on consolidated memories (top 10)
     2. Get recent episodes (last 24h)
     3. Get active goals from scheduled jobs
     4. Score and rank all items by relevance
     5. Fit within token budget (prioritize high-confidence, recent, relevant)
   - Output: formatted string to inject into system prompt

2. Update `src/memory/working.ts`:
   - Integrate retrieval pipeline
   - On each new message: retrieve relevant context
   - Inject into system prompt alongside soul.md

3. Update `src/core/agent.ts`:
   - Use retrieval pipeline in context building

4. Tests:
   - Retrieval returns relevant context
   - Token budget is respected
   - Higher confidence memories are prioritized
   - Context is properly formatted for LLM

---

## Task 3.6: Memory CLI Commands

**Priority:** P1
**Depends on:** 3.2, 3.3, 3.4
**Estimated effort:** 1 hour

### Steps:
1. Add CLI commands:
   - `mama memory search <query>` — semantic search across all memories
   - `mama memory list [--category X] [--min-confidence Y]` — list consolidated memories
   - `mama memory forget <id>` — deactivate a specific memory
   - `mama memory consolidate` — manually trigger consolidation
   - `mama memory stats` — show memory statistics

2. Pretty-print results with color and formatting

---

## Task 3.7: Integration Test

**Priority:** P0
**Depends on:** All above

### Test scenarios:
1. Have a conversation about a project → check episodes are stored
2. Search for the conversation topic → semantic search returns it
3. Run consolidation → check memories are created
4. Have a new conversation → check relevant memories are injected into context
5. Ask Mama "what do you know about X?" → should reference consolidated knowledge
6. Run decay → check unreinforced memories lose confidence

---

## Phase 3 Summary

- **Lines of code estimate:** ~2500-3000 (cumulative: ~6500)
- **Files:** ~15-20 new
- **What works:** Agent remembers everything, consolidates patterns, injects relevant context, evolves its soul.md
- **What's next:** Phase 4 makes Mama a living entity (scheduler, Telegram, daemon mode)
