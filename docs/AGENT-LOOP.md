# Agent Loop — ReAct + Planning

## Overview

Mama's agent loop implements the ReAct (Reason → Act → Observe) pattern with an additional Planning step for complex tasks. The agent doesn't just respond — it reasons about what needs to be done, makes a plan, executes it step by step, and adapts based on results.

---

## Core Loop

```typescript
async function agentLoop(input: UserInput): Promise<AgentResponse> {
  // 1. Load context
  const context = await buildContext(input);

  // 2. Reason — understand what the user wants
  const understanding = await reason(context);

  // 3. Route — is this a simple response or does it need action?
  if (understanding.requiresAction) {
    // 4. Plan — break into steps
    const plan = await createPlan(understanding, context);

    // 5. Confirm — if plan has side-effects, ask user
    if (plan.hasSideEffects) {
      const approved = await confirmPlan(plan);
      if (!approved) return { text: "Plan cancelled. What would you like instead?" };
    }

    // 6. Execute — run each step through sandbox
    const results = await executePlan(plan);

    // 7. Synthesize — create response from results
    return synthesizeResponse(results, context);
  } else {
    // Simple response — direct LLM generation
    return generateResponse(understanding, context);
  }
}
```

---

## Context Building

```typescript
async function buildContext(input: UserInput): Promise<AgentContext> {
  return {
    // Current conversation
    messages: input.conversationHistory,

    // Agent identity
    soul: await loadSoul(),

    // Relevant memories (semantic search on user's message)
    memories: await memory.retrieve(input.text, { limit: 10 }),

    // Active scheduled jobs (for awareness)
    activeJobs: await scheduler.getActiveJobs(),

    // Available tools (from capabilities + skills)
    availableTools: await getAvailableTools(),

    // Current system state
    systemState: {
      time: new Date(),
      platform: process.platform,
      workspaceContents: await listWorkspace(),
    }
  };
}
```

---

## Tool Definitions

Tools are the bridge between the agent's decisions and the capability sandbox:

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: ZodSchema;       // Zod schema for validation
  capability: string;          // Which capability this tool uses
  action: string;              // What action within the capability
  execute: (params: unknown) => Promise<ToolResult>;
}

// Example: File read tool
const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Use this when you need to examine a file's content.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative file path"),
    encoding: z.enum(["utf-8", "base64"]).default("utf-8")
  }),
  capability: "filesystem",
  action: "read",
  execute: async (params) => {
    // Sandbox checks permissions automatically
    return await sandbox.execute("filesystem", "read", params);
  }
};

// Core tools available to the agent:
const CORE_TOOLS: Tool[] = [
  // Filesystem
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchFilesTool,
  // Shell
  executeCommandTool,
  // Network
  httpRequestTool,
  // Memory
  searchMemoryTool,
  saveNoteTool,
  // Scheduler
  createJobTool,
  listJobsTool,
  // Meta
  askUserTool,          // Ask the user a clarifying question
  reportProgressTool,   // Report progress on multi-step tasks
];
```

---

## Planning

For tasks that require multiple steps:

```typescript
interface Plan {
  goal: string;                    // What we're trying to achieve
  steps: PlanStep[];               // Ordered steps
  hasSideEffects: boolean;         // Does this modify anything?
  estimatedDuration: string;       // "~30 seconds", "~2 minutes"
  risks: string[];                 // Potential issues
}

interface PlanStep {
  id: number;
  description: string;             // Human-readable description
  tool: string;                    // Tool to use
  params: Record<string, unknown>; // Parameters for the tool
  dependsOn: number[];             // Step IDs this depends on
  canFail: boolean;                // Is failure of this step acceptable?
  fallback?: string;               // What to do if this fails
}
```

**Planning prompt (sent to LLM):**

```
You are Mama, a personal AI agent. You need to create an execution plan.

## User Request
{user_message}

## Available Tools
{tool_descriptions}

## Current Context
{relevant_memories}
{system_state}

## Instructions
Create a plan to fulfill the user's request. For each step:
1. Choose the appropriate tool
2. Specify exact parameters
3. Note dependencies between steps
4. Identify risks and fallbacks
5. Mark whether each step has side-effects

Output your plan as JSON:
{
  "goal": "...",
  "steps": [
    {
      "id": 1,
      "description": "...",
      "tool": "tool_name",
      "params": { ... },
      "dependsOn": [],
      "canFail": false,
      "fallback": "..."
    }
  ],
  "hasSideEffects": true/false,
  "estimatedDuration": "...",
  "risks": ["..."]
}

IMPORTANT:
- Prefer the minimum number of steps needed
- Read before write (always check current state first)
- Side-effect steps should be as late in the plan as possible
- Never plan steps that exceed available capabilities
```

---

## Execution Engine

```typescript
async function executePlan(plan: Plan): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  const completed = new Set<number>();

  for (const step of plan.steps) {
    // Check dependencies
    const depsReady = step.dependsOn.every(id => completed.has(id));
    if (!depsReady) {
      // This shouldn't happen with proper ordering, but handle gracefully
      results.push({ stepId: step.id, status: "skipped", reason: "Dependencies not met" });
      continue;
    }

    // Execute step
    const tool = findTool(step.tool);
    const result = await tool.execute(step.params);

    if (result.ok) {
      results.push({ stepId: step.id, status: "success", output: result.value });
      completed.add(step.id);
    } else {
      // Step failed
      if (step.canFail) {
        results.push({ stepId: step.id, status: "failed-acceptable", error: result.error });
        completed.add(step.id); // Still mark as "done" so dependents can proceed
      } else if (step.fallback) {
        // Try fallback
        const fallbackResult = await executeFallback(step.fallback, result.error);
        results.push({ stepId: step.id, status: "fallback", output: fallbackResult });
        completed.add(step.id);
      } else {
        // Critical failure — stop execution, ask user
        results.push({ stepId: step.id, status: "failed-critical", error: result.error });
        break;
      }
    }

    // Store episode for each step (for memory)
    await memory.storeEpisode({
      role: "system",
      content: `Executed step: ${step.description}. Result: ${result.ok ? 'success' : 'failed'}`,
      metadata: { taskType: "execution", toolUsed: step.tool }
    });
  }

  return results;
}
```

---

## LLM Integration Pattern

The agent communicates with LLMs using a standardized tool-use pattern:

```typescript
interface LLMRequest {
  system: string;                    // System prompt (soul + context)
  messages: Message[];               // Conversation + injected context
  tools: ToolDefinition[];           // Available tools in LLM format
  model?: string;                    // Specific model (or let router decide)
  temperature?: number;              // Default: 0.3 for action, 0.7 for conversation
  maxTokens?: number;
}

interface LLMResponse {
  content?: string;                  // Text response
  toolCalls?: ToolCall[];           // Tool invocations
  usage: { inputTokens: number; outputTokens: number };
}

// The agent loop continues until the LLM produces content without tool calls
async function runAgentTurn(request: LLMRequest): Promise<string> {
  let response = await llm.complete(request);

  while (response.toolCalls && response.toolCalls.length > 0) {
    // Execute each tool call through the sandbox
    const toolResults = await Promise.all(
      response.toolCalls.map(call => executeToolCall(call))
    );

    // Add results to conversation and continue
    request.messages.push(
      { role: "assistant", content: response.content, toolCalls: response.toolCalls },
      { role: "tool", results: toolResults }
    );

    response = await llm.complete(request);
  }

  return response.content;
}
```

---

## Error Recovery

```typescript
// Global error recovery strategy
const ERROR_STRATEGIES = {
  LLM_TIMEOUT: {
    action: "retry",
    maxRetries: 2,
    fallback: "switch_provider",     // Try Ollama if Claude times out
  },
  LLM_RATE_LIMIT: {
    action: "wait_and_retry",
    waitMs: 5000,
    maxRetries: 3,
  },
  PERMISSION_DENIED: {
    action: "report_to_user",       // Don't retry, inform user
  },
  TOOL_ERROR: {
    action: "retry_with_adjustment", // Let LLM adjust parameters
    maxRetries: 1,
  },
  UNKNOWN: {
    action: "report_to_user",
  }
};
```
