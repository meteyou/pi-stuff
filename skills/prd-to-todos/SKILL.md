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

Use the PRD number from step 1. Prefix every title with `PRD #N - Task M/T:` where N is the PRD number, M is the task's unique position in the execution order (1…T), and T is the total task count.

Example for `PRD #2: User Authentication`:

- `PRD #2 - Task 1/4: Database Schema & Models`
- `PRD #2 - Task 2/4: Auth API Endpoints`
- `PRD #2 - Task 3/4: Login UI & Session Handling`
- `PRD #2 - Task 4/4: E2E Tests & Error Handling`

**Every task gets a unique sequence number** — never reuse a number, even for independent tasks at the same dependency level. Number the tasks consecutively from `1` to `T` in a valid dependency order (every task's blockers have lower numbers). With 16 tasks, the titles must read `Task 1/16` … `Task 16/16`, each number exactly once.

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

## Splitting an existing task into subtasks

Use this when the user asks to split a task that already exists (e.g. it turned out to be too big or kept failing in `/prd-loop`). Never renumber the existing tasks — split with a **hierarchical suffix** instead, so the original numbering and `T` stay stable.

### Labels

Numbers and lowercase letters alternate, one level per segment:

| Split | Subtask labels |
|-------|----------------|
| Task `17/20` (1st level) | `17a/20`, `17b/20`, `17c/20`, … |
| Task `17a/20` (2nd level) | `17a1/20`, `17a2/20`, `17a3/20`, … |
| Task `17a1/20` (3rd level) | `17a1a/20`, `17a1b/20`, … |

- Keep `T` (the total after the slash) of the original breakdown — do NOT change it.
- Title format stays `PRD #N - Task <label>: <title>`, e.g. `PRD #1 - Task 17a1/20: Runtime memory and sprintf replacements`.
- Number the subtasks consecutively in a valid dependency order (`17a1` before `17a2`, …), each label exactly once. Never reuse a label of a deleted task.
- `/prd-loop` and `/prd-loop-pro` sort hierarchically (`17` < `17a` < `17a1` < `17a2` < `17a10` < `17b` < `18`) and show subtasks indented below their parent with a subtask progress count.

### Process

1. Fetch the task to split and its blockers/dependents. Draft the subtasks as vertical slices (step 3) and quiz the user (step 4).
2. Create the subtask todos (blockers first) with the body structure above. Tags: `task` + `prd-N`.
   - The first subtask(s) take over the parent's `Blocked by` (only the blockers that are still open matter).
   - Later subtasks are blocked by the earlier subtasks they depend on.
3. Keep the parent task as **umbrella / close-out task** (preferred): it stays open, its `Blocked by` is replaced with the last subtask(s), and its "What to build" / acceptance criteria are reduced to what remains after the subtasks (integration, acceptance). If nothing remains, the parent may be deleted instead — the subtasks are still displayed correctly.
4. Tasks that were blocked by the parent keep pointing at the parent (umbrella) — or, if the parent was deleted, at the last subtask(s). Check every `Blocked by` / `Next task` reference to the split task.
5. Add one Task Index row per subtask directly below the parent row (`| 17a1/20 | … | TODO-<id> | … | ⏳ blocked |`), update the parent row's `Blocked by`, remove rows of deleted tasks and update `Next up:` if needed.

6. If the split task has the status `needs-human` (released by `/prd-loop-pro`), leave the status as it is and tell the user to choose **Re-open** for it at the next `/prd-loop-pro` start. Uncommitted changes of the failed attempt must be committed, stashed or discarded first; the loop only starts with a clean working tree.

The same applies when splitting a subtask again (`17a` → `17a1`, `17a2`, …).

`/prd-loop-pro` can do this split itself: **Split task** in its pause menu follows the same rules. Use this section when the split is made by hand in the main session, for example after **Release / hand over**.

### Task bodies and follow-up work

The implementer of `/prd-loop` and `/prd-loop-pro` cannot create or change todos. Do not write task bodies that ask it to ("create a follow-up todo for the rest"). Size every task so that one run can finish it; if the size is only known after measuring, say so in the task and let the implementer report the task as blocked with a proposed split.
