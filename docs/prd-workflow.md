# PRD Workflow: From Idea to Implementation

A structured workflow for turning a vague idea into a fully planned and sequentially executable set of tasks — using
four skills that chain together seamlessly.

**Based on:** [5 Agent Skills I Use Every Day](https://www.aihero.dev/5-agent-skills-i-use-every-day) by Matt Pocock.
Adapted for local todo management using the
[todos extension](https://github.com/mitsuhiko/agent-stuff) from mitsuhiko/agent-stuff.

## Overview

```
grill-me → write-a-prd → prd-to-todos → work-on-prd
```

| Step | Skill | What it does |
|------|-------|-------------|
| 1 | `grill-me` | Stress-test your idea through relentless interview |
| 2 | `write-a-prd` | Turn decisions into a structured PRD (saved as a numbered todo) |
| 3 | `prd-to-todos` | Break PRD into sequenced, dependency-aware tasks |
| 4 | `work-on-prd` | Execute tasks in order, tracking progress in the PRD |

## Step-by-Step

### 1. Grill Me — Define the idea

Start a session and describe what you want to build. Use `skill:grill-me` or just say "grill me about this idea":

```
I want to add a caching layer to our API. Frequently requested
endpoints should be served from cache with configurable TTLs.
skill:grill-me
```

The agent will interview you relentlessly — asking about edge cases, constraints, dependencies, and design decisions
until every branch of the decision tree is resolved.

When done, it summarizes all decisions and asks whether to continue with creating a PRD.

### 2. Write a PRD — Formalize the plan

The `write-a-prd` skill takes the interview results and creates a structured PRD document containing:

- Problem Statement
- Solution
- User Stories (numbered)
- Implementation Decisions
- Testing Decisions
- Out of Scope

The PRD is saved as a **numbered todo**:

```
Title: PRD #1: API Response Caching
Tags:  prd, prd-1
```

The PRD number auto-increments based on existing PRDs. When done, it asks whether to break the PRD into tasks.

### 3. PRD to Todos — Create executable tasks

The `prd-to-todos` skill breaks the PRD into **vertical slices** (tracer bullets) — thin end-to-end tasks that each
deliver a demoable result.

Each task gets:

- A **sequenced title**: `PRD #1 - Task 1/4: Cache Storage & TTL Config`
- **Acceptance criteria** in the body
- **Blocked by** references to predecessor tasks
- **Next task** pointer for chaining
- The same **`prd-1` tag** as the parent PRD

After creating all tasks, the skill **updates the PRD todo** with a Task Index:

```markdown
## Task Index

| #   | Task                       | Todo         | Blocked by   | Status     |
|-----|----------------------------|--------------|--------------|------------|
| 1/4 | Cache Storage & TTL Config | TODO-abc123  | —            | 🔄 open    |
| 2/4 | Middleware Integration     | TODO-def456  | TODO-abc123  | ⏳ blocked  |
| 3/4 | Cache Invalidation Logic   | TODO-ghi789  | TODO-def456  | ⏳ blocked  |
| 4/4 | Monitoring & E2E Tests     | TODO-jkl012  | TODO-ghi789  | ⏳ blocked  |
```

### 4. Work on PRD — Execute tasks sequentially

When you're ready to implement, use `skill:work-on-prd` or say "work on PRD #1".

The skill:

1. **Fetches all tasks** for the PRD (by `prd-N` tag)
2. **Syncs the Task Index** — checks actual todo status, updates the PRD
3. **Finds the next actionable task** — first open task whose blockers are all closed
4. **Works on it** — claims the task, implements it, verifies acceptance criteria
5. **Updates the PRD** — marks the task as ✅, unblocks the next task
6. **Asks to continue** — or stops if all tasks are done

## Alternative Entry Points

You don't have to follow the full chain every time:

### Start from `/todos`

Open `/todos`, select a **PRD** todo, and say "work". The agent reads the Task Index in the PRD body and works through
the tasks — skipping already completed ones.

### Start from a single task

Open `/todos`, select a specific **task** (e.g., `PRD #1 - Task 3/4: ...`), and say "work". The agent checks its
blockers, and either starts working or tells you which tasks need to be done first.

### Create multiple PRDs first, implement later

You can run `grill-me` → `write-a-prd` → `prd-to-todos` multiple times to plan several features:

```
PRD #1: API Response Caching                          [prd, prd-1]
PRD #1 - Task 1/4: Cache Storage & TTL Config         [task, prd-1]
PRD #1 - Task 2/4: Middleware Integration              [task, prd-1]
PRD #1 - Task 3/4: Cache Invalidation Logic            [task, prd-1]
PRD #1 - Task 4/4: Monitoring & E2E Tests              [task, prd-1]
PRD #2: User Authentication                            [prd, prd-2]
PRD #2 - Task 1/3: Database Schema & Models            [task, prd-2]
PRD #2 - Task 2/3: Auth API Endpoints                  [task, prd-2]
PRD #2 - Task 3/3: Login UI & Session Handling         [task, prd-2]
```

Then come back later and say `skill:work-on-prd` to pick which PRD to implement.

## How Status Tracking Works

Status is synchronized in **two places** for resilience:

| Source of Truth | What | Updated by |
|----------------|------|-----------|
| **Individual task todos** (status field) | Whether a task is open/closed | `work-on-prd` after each task |
| **PRD Task Index** (in PRD body) | Dashboard view with dependencies + status | `work-on-prd` at start + after each task |

The Task Index is a **cache** that gets re-synced from the actual task statuses every time `work-on-prd` starts. This
means it works correctly even if:

- A session crashes mid-task
- Someone closes a task manually
- Tasks are worked on across multiple sessions
