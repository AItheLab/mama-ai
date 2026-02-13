# Memory System — Sleep Time Architecture

## Overview

Mama's memory system is the core differentiator. While other agents use simple key-value stores or raw conversation logs, Mama implements a three-layer memory architecture inspired by how human memory actually works: immediate recall, episodic storage, and sleep-time consolidation.

---

## Three Layers

### Layer 1: Working Memory (Context Window)

**What:** The active conversation context sent to the LLM.
**Duration:** Current session only.
**Size:** Managed to fit within LLM context window limits.

```typescript
interface WorkingMemory {
  // System prompt + soul.md content
  systemContext: string;

  // Relevant consolidated memories injected for this conversation
  relevantMemories: ConsolidatedMemory[];

  // Current conversation messages
  messages: Message[];

  // Active goals/tasks from scheduler
  activeGoals: string[];

  // Total token count tracking
  tokenCount: number;
  maxTokens: number;
}
```

**Context Management Strategy:**
1. System prompt + soul.md: always included (~500-1000 tokens)
2. Relevant consolidated memories: retrieved via semantic search on user's message (~500-2000 tokens)
3. Recent messages: last N messages kept in full
4. Older messages in session: progressively summarized
5. If approaching limit: compress oldest non-summarized messages

```
Token Budget Example (100K window):
┌─────────────────────────────┐
│ System + Soul    (~1,500)   │ ← Always present
├─────────────────────────────┤
│ Memories         (~2,000)   │ ← Semantically relevant
├─────────────────────────────┤
│ Summarized old   (~1,000)   │ ← Compressed history
├─────────────────────────────┤
│ Recent messages  (~10,000)  │ ← Full fidelity
├─────────────────────────────┤
│ Available for    (~85,500)  │ ← Agent reasoning
│ response                    │
└─────────────────────────────┘
```

---

### Layer 2: Episodic Memory (History)

**What:** Every interaction stored permanently with metadata and embeddings.
**Duration:** Permanent (until explicitly pruned).
**Storage:** SQLite + vector embeddings.

```typescript
interface Episode {
  id: string;                    // UUID
  timestamp: Date;
  channel: "terminal" | "telegram" | "api" | "heartbeat" | "cron";
  role: "user" | "agent" | "system";
  content: string;
  embedding: Float32Array;       // Vector embedding for semantic search
  metadata: {
    taskType?: string;           // "question", "command", "planning", "casual"
    toolsUsed?: string[];        // Which capabilities were invoked
    emotionalTone?: string;      // Detected emotional context
    topics?: string[];           // Extracted topics
    entities?: string[];         // People, places, projects mentioned
    importance?: number;         // 0-1 estimated importance
  };
  consolidated: boolean;         // Has this been processed by Sleep Time?
  consolidatedAt?: Date;
}
```

**Retrieval methods:**
- **Semantic search**: Find episodes similar to a query using vector similarity
- **Temporal search**: Find episodes by time range
- **Topic search**: Find episodes by extracted topics/entities
- **Hybrid**: Combine semantic + temporal with weighted scoring

```typescript
interface MemoryQuery {
  semanticQuery?: string;        // Natural language query
  timeRange?: { start: Date; end: Date };
  topics?: string[];
  entities?: string[];
  minImportance?: number;
  limit?: number;
  strategy?: "semantic" | "temporal" | "hybrid";
}
```

**Embedding generation:**
- All embeddings generated locally via Ollama (nomic-embed-text)
- No data sent to external APIs for embedding
- Dimension: 768
- Batch processing for efficiency

---

### Layer 3: Consolidated Memory (Sleep Time)

**What:** Background process that analyzes episodic memory and extracts higher-level understanding.
**When:** Runs periodically when agent is idle (default: every 6 hours, minimum 10 new episodes).
**Model:** Uses Claude (configurable) for consolidation reasoning.

This is the "sleep" in Sleep Time Architecture — like how human brains consolidate memories during sleep.

```typescript
interface ConsolidatedMemory {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  category: MemoryCategory;
  content: string;               // The consolidated insight
  confidence: number;            // 0.0 to 1.0
  sourceEpisodes: string[];      // Episode IDs that contributed
  embedding: Float32Array;
  active: boolean;               // Can be deactivated ("forgotten")
  reinforcementCount: number;    // How many times this was reinforced
  lastReinforcedAt: Date;
  contradictions?: string[];     // IDs of memories that contradict this
}

type MemoryCategory =
  | "fact"           // "User works at VML THE COCKTAIL"
  | "preference"     // "User prefers TypeScript over JavaScript"
  | "pattern"        // "User usually codes in the evening"
  | "goal"           // "User wants to launch an AI consulting business"
  | "relationship"   // "User's partner works in micropigmentation"
  | "skill"          // "User is experienced with Vue.js"
  | "routine"        // "User trains for running on Tuesday/Thursday"
  | "emotional"      // "User gets frustrated when builds fail silently"
  | "project";       // "User is building U&Me AI platform"
```

---

## Sleep Time Consolidation Process

This is the most important algorithm in Mama.

### Step 1: Gather Unconsolidated Episodes

```typescript
async function gatherEpisodes(): Promise<Episode[]> {
  return db.episodes
    .where('consolidated', false)
    .orderBy('timestamp', 'asc')
    .limit(100)  // Process in batches
    .toArray();
}
```

### Step 2: Cluster and Analyze

Group related episodes and send to LLM for analysis:

```
CONSOLIDATION PROMPT:

You are the memory consolidation system for a personal AI agent called Mama.
Your job is to analyze recent interactions and extract lasting knowledge.

## Current Consolidated Memories
{existing_memories}

## New Episodes to Process
{unconsolidated_episodes}

## Instructions
Analyze the new episodes and:

1. EXTRACT new facts, preferences, patterns, goals, relationships, skills, routines
2. REINFORCE existing memories that are confirmed by new episodes
3. UPDATE existing memories that need correction based on new information
4. CONTRADICT flag existing memories that conflict with new information
5. DECAY reduce confidence of memories that haven't been reinforced in a long time
6. CONNECT identify relationships between memories

For each action, output:
{
  "new": [{ "category": "...", "content": "...", "confidence": 0.0-1.0, "sourceEpisodes": [...] }],
  "reinforce": [{ "memoryId": "...", "reason": "..." }],
  "update": [{ "memoryId": "...", "newContent": "...", "reason": "..." }],
  "contradict": [{ "memoryId": "...", "contradictedBy": "...", "resolution": "..." }],
  "decay": [{ "memoryId": "...", "newConfidence": 0.0-1.0 }],
  "connect": [{ "memoryA": "...", "memoryB": "...", "relationship": "..." }]
}

IMPORTANT:
- Only extract information with clear evidence from the episodes
- Assign lower confidence to inferred vs. explicitly stated information
- Prefer updating existing memories over creating duplicates
- Flag contradictions rather than silently overwriting
```

### Step 3: Apply Changes

```typescript
async function applyConsolidation(result: ConsolidationResult): Promise<void> {
  await db.transaction(async (tx) => {
    // Create new memories
    for (const mem of result.new) {
      await tx.memories.insert({
        ...mem,
        id: generateId(),
        embedding: await embed(mem.content),
        active: true,
        reinforcementCount: 1,
        lastReinforcedAt: new Date()
      });
    }

    // Reinforce existing
    for (const r of result.reinforce) {
      await tx.memories.update(r.memoryId, {
        reinforcementCount: sql`reinforcement_count + 1`,
        lastReinforcedAt: new Date(),
        confidence: sql`MIN(confidence + 0.05, 1.0)`
      });
    }

    // Update existing
    for (const u of result.update) {
      await tx.memories.update(u.memoryId, {
        content: u.newContent,
        updatedAt: new Date(),
        embedding: await embed(u.newContent)
      });
    }

    // Handle contradictions
    for (const c of result.contradict) {
      await tx.memories.update(c.memoryId, {
        contradictions: sql`json_insert(contradictions, '$[#]', ${c.contradictedBy})`
      });
      // Reduce confidence of contradicted memory
      await tx.memories.update(c.memoryId, {
        confidence: sql`MAX(confidence - 0.2, 0.1)`
      });
    }

    // Decay old memories
    for (const d of result.decay) {
      await tx.memories.update(d.memoryId, {
        confidence: d.newConfidence
      });
    }

    // Mark episodes as consolidated
    const episodeIds = /* all processed episode IDs */;
    await tx.episodes.update(episodeIds, {
      consolidated: true,
      consolidatedAt: new Date()
    });
  });
}
```

### Step 4: Update Soul

After consolidation, regenerate relevant sections of `soul.md`:

```typescript
async function updateSoul(): Promise<void> {
  const activeMemories = await db.memories
    .where('active', true)
    .where('confidence', '>', 0.5)
    .orderBy('confidence', 'desc')
    .toArray();

  const grouped = groupBy(activeMemories, 'category');

  const soulContent = await llm.generate({
    prompt: `Update the agent's soul document based on current consolidated memories.
    Keep it concise and actionable. This is the agent's self-knowledge.`,
    memories: grouped
  });

  await fs.writeFile(SOUL_PATH, soulContent);
}
```

---

## Memory Decay & Forgetting

Not all memories should live forever. Mama implements intelligent forgetting:

```typescript
async function decayMemories(): Promise<void> {
  const now = new Date();

  // Memories not reinforced in 30+ days lose confidence
  await db.memories
    .where('lastReinforcedAt', '<', daysAgo(30))
    .where('confidence', '>', 0.3)
    .update({
      confidence: sql`confidence * 0.9`  // 10% decay
    });

  // Memories with confidence below 0.1 are deactivated
  await db.memories
    .where('confidence', '<', 0.1)
    .update({ active: false });

  // Note: deactivated memories are NOT deleted
  // They can be reactivated if reinforced again
}
```

**Why not delete?** Because a memory that seemed unimportant can become relevant again. "Forgetting" means deprioritizing, not erasing. The user can always ask Mama to recall something specific, which triggers a deep search including inactive memories.

---

## Memory Retrieval for Conversations

When a user sends a message, Mama retrieves relevant context:

```typescript
async function retrieveContext(userMessage: string): Promise<RetrievedContext> {
  // 1. Embed the user's message
  const queryEmbedding = await embed(userMessage);

  // 2. Semantic search on consolidated memories
  const relevantMemories = await db.memories
    .semanticSearch(queryEmbedding, { limit: 10, minConfidence: 0.3 });

  // 3. Recent episodic context (last 24h interactions)
  const recentEpisodes = await db.episodes
    .where('timestamp', '>', hoursAgo(24))
    .orderBy('timestamp', 'desc')
    .limit(20)
    .toArray();

  // 4. Active goals and scheduled tasks
  const activeJobs = await db.jobs
    .where('enabled', true)
    .toArray();

  // 5. Score and rank by relevance
  const scored = scoreAndRank(relevantMemories, recentEpisodes, activeJobs);

  // 6. Fit within token budget
  return fitToTokenBudget(scored, TOKEN_BUDGET_FOR_CONTEXT);
}
```

---

## Privacy & Security

- All memory stored locally in encrypted SQLite
- Embeddings generated locally via Ollama (no data leaves machine)
- Consolidation uses Claude API but sends minimal context (summarized episodes, not raw conversations)
- User can: view all memories, delete specific memories, pause consolidation, export/import memories
- Memory audit: every consolidation action is logged with before/after state
