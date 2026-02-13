# AGENTS.md

## Project Context
- Project root: `/Users/alex/Desktop/Mama`
- Current roadmap focus: `tasks/PHASE-2.md`
- Security model: all side-effectful operations must route through sandbox capabilities.

## Working Rules
1. Do not revert unrelated existing changes.
2. Keep compatibility with:
   - `src/core/tools/*`
   - `src/sandbox/*`
3. Prefer incremental, test-backed changes.
4. Before closing a development task, run:
   - `pnpm typecheck`
   - `pnpm test:run`
   - `pnpm lint`

## Phase 2 Execution Notes
- `Task 2.7`: agent tool loop + planner/executor + tests.
- `Task 2.8`: end-to-end integration scenarios:
  1. list workspace files
  2. create file in workspace
  3. deny SSH key read
  4. allow safe shell listing
  5. deny destructive shell command
  6. allow git status
  7. multi-step plan execution

## Quality Gate
- Changes must preserve sandbox enforcement.
- Tests should validate both success and denied paths.
