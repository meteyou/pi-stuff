---
name: prd-to-todos
description: Break a PRD into independently-grabbable todos using tracer-bullet vertical slices. Use when user wants to convert a PRD to todos, create implementation tasks, or break down a PRD into work items.
---

# PRD to Todos

Break a PRD into independently-grabbable todos using vertical slices (tracer bullets).

## Process

### 1. Locate the PRD

Ask the user which PRD to break down. If the PRD is a todo, fetch it with the todo tool.

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

Use this structure for the todo body:

```
## Parent PRD

TODO-<prd-todo-id>

## What to build

Concise description of this vertical slice. Describe end-to-end behavior, not layer-by-layer. Reference sections of the parent PRD rather than duplicating.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- TODO-<id> (if any), or "None - can start immediately"

## User stories addressed

Reference by number from the parent PRD:

- User story 3
- User story 7
```

Tag each todo with `task` and any relevant tags from the PRD.
