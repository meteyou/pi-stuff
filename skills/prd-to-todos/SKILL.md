---
name: prd-to-todos
description: Break a PRD into independently-grabbable todos using tracer-bullet vertical slices. Use when user wants to convert a PRD to todos, create implementation tasks, or break down a PRD into work items.
---

# PRD to Todos

Break a PRD into independently-grabbable todos using vertical slices (tracer bullets).

## Process

### 1. Locate the PRD

Ask the user which PRD to break down. If the PRD is a todo, fetch it with the todo tool. Extract the PRD number from the title (e.g., `PRD #3: ...` → number is `3`).

### 2. Explore the codebase (optional)

If not already familiar with the codebase, explore it to understand the current state.

### 3. Draft vertical slices

Break the PRD into **tracer bullet** tasks. Each task is a thin vertical slice cutting through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice show:

- **Title**: short descriptive name
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories from the PRD this addresses

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?

Iterate until the user approves.

### 5. Create the todos

For each approved slice, create a todo using the todo tool. Create them in dependency order (blockers first) so real todo IDs can be referenced.

#### Todo title format

Use the PRD number from step 1. Prefix every title with `PRD #N - Task M/T:` where N is the PRD number, M is the sequence position, and T is the total task count.

Example for `PRD #2: User Authentication`:

- `PRD #2 - Task 1/4: Database Schema & Models`
- `PRD #2 - Task 2/4: Auth API Endpoints`
- `PRD #2 - Task 3/4: Login UI & Session Handling`
- `PRD #2 - Task 4/4: E2E Tests & Error Handling`

Tasks at the same dependency level share the same sequence number (e.g., two independent tasks could both be `Task 1/4`).

#### Todo body structure

Use this structure for the todo body:

```markdown
## Parent PRD

TODO-<prd-todo-id> (PRD #N: <prd-title>)

## What to build

Concise description of this vertical slice. Describe end-to-end behavior, not layer-by-layer. Reference sections of the parent PRD rather than duplicating.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- TODO-<id> (PRD #N - Task M/T: <title>), or "None — can start immediately"

## Next task

- TODO-<id> (PRD #N - Task M+1/T: <title>), or "None — this is the last task"

## User stories addressed

Reference by number from the parent PRD:

- User story 3
- User story 7
```

#### Tagging

Tag each todo with `task` and `prd-N` (same tag as the parent PRD, e.g., `prd-2`). This enables filtering all todos belonging to one PRD.

### 6. Update the PRD todo with task index

After all tasks are created, **update the parent PRD todo body** using the todo `update` action. Prepend a task index block **before** the existing PRD content.

The Task Index encodes **dependencies and status** so that any agent reading the PRD immediately knows which tasks are actionable:

```markdown
## ⚠️ Working on this PRD

Do NOT implement this PRD directly. It has been broken into sequential tasks.
Work through the tasks below in order. Use /prd-loop (or /ralph) to execute autonomously, or pick individual tasks.

## Task Index

| # | Task | Todo | Blocked by | Status |
|---|------|------|------------|--------|
| 1/4 | Database Schema & Models | TODO-<id> | — | 🔄 open |
| 2/4 | Auth API Endpoints | TODO-<id> | TODO-<task1-id> | ⏳ blocked |
| 3/4 | Login UI & Session Handling | TODO-<id> | TODO-<task2-id> | ⏳ blocked |
| 4/4 | E2E Tests & Error Handling | TODO-<id> | TODO-<task3-id> | ⏳ blocked |

Start with: **TODO-<first-task-id>** (PRD #N - Task 1/T: <title>)

---

<original PRD content follows>
```

Status values:
- `🔄 open` — actionable, no unresolved blockers
- `⏳ blocked` — waiting for blocker tasks to complete
- `✅ closed` — completed (set by `/prd-loop` after task completion)

This ensures that when someone selects the PRD via `/todo` and says "work", the agent sees the task index with dependencies and can determine exactly which task to work on next — even if earlier tasks were already completed in a previous session.
