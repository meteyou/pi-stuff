# PRD Workflow: From Idea to Implementation

A structured workflow for turning a vague idea into a fully planned and autonomously executable set of tasks — using
skills and an extension that chain together seamlessly.

**Based on:** [5 Agent Skills I Use Every Day](https://www.aihero.dev/5-agent-skills-i-use-every-day) by Matt Pocock.
Adapted for local todo management using the
[todos extension](https://github.com/mitsuhiko/agent-stuff) from mitsuhiko/agent-stuff.

## Overview

```
grill-me → write-a-prd → prd-to-todos → /prd-loop (or /prd-loop-pro)
```

| Step | Trigger | What it does |
|------|---------|-------------|
| 1 | `skill:grill-me` | Stress-test your idea through relentless interview |
| 2 | `skill:write-a-prd` | Turn decisions into a structured PRD (saved as a numbered todo) |
| 3 | `skill:prd-to-todos` | Break PRD into sequenced, dependency-aware tasks |
| 4 | `/prd-loop` (or `/ralph`) | Execute tasks autonomously with isolated subagents |
| 4 (alt.) | `/prd-loop-pro` (or `/ralph-pro`) | Same, with a review-fix pipeline per task, saved per-step settings and human hand-off |

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

### 4. PRD Loop — Execute tasks autonomously

When you're ready to implement, run `/prd-loop` (or its alias `/ralph`):

```
/prd-loop prd-1
```

The extension:

1. **Checks git status** — aborts if the working directory is dirty
2. **Selects the PRD** — via argument or interactive dialog
3. **Configures the run** — retry count, smart commits, model selection (via dialogs or flags)
4. **Shows a confirmation dialog** — PRD name, task count, configuration summary
5. **Runs the orchestrator loop:**
   - Resolves task dependencies (topological sort)
   - Spawns a **fresh subagent process** per task (isolated context window)
   - Each subagent implements the task, validates acceptance criteria, runs tests/build/lint
   - Returns structured JSON result (`{success, errors, summary}`)
   - On success: auto-commits, updates task todo to closed, updates PRD Task Index
   - On failure: retries with error context (if retries configured), or stops the loop
6. **Shows a live overlay** — per-task status, elapsed time, cost, retries, with ↑/↓ navigation (scrolls through long
   task details first) and expandable task details (`a` expands/collapses all, `o` opens the subagent output)
7. **Keeps the overlay open after the run** — the header shows the outcome and totals; tasks can still be expanded and
   inspected. `Esc`/`q` closes it
8. **Posts a final summary to the chat** — a collapsible entry (not sent to the LLM): collapsed it shows failed/aborted
   tasks and the totals, `Ctrl+O` expands it to all tasks

While the loop is running, `Esc` (twice) closes the overlay and aborts the loop.

#### Commands

| Command | Description |
|---------|-------------|
| `/prd-loop [prd-N]` | Execute all open tasks of a PRD autonomously |
| `/ralph [prd-N]` | Alias for `/prd-loop` |

#### Flags

Skip interactive dialogs with command-line flags:

```
/prd-loop prd-1 --retry-fixes=3 --smart-commits --model=anthropic/claude-sonnet-4-5
```

| Flag | Description | Default |
|------|-------------|---------|
| `--retry-fixes=N` | Number of retry attempts per failed task | `0` (no retries) |
| `--smart-commits` | Use a committer subagent for granular conventional commits | off (single auto-commit) |
| `--model=<id>` | Model for subagents (`provider/model-id` or just `model-id`) | active model |

#### How it works under the hood

Each task runs in a **fresh, isolated context window** via a spawned `pi` subprocess. This keeps the LLM in the
"smart zone" (first ~40% of context window) and prevents degradation over time — the core idea behind the
[Ralph methodology](https://www.aihero.dev/getting-started-with-ralph).

The orchestrator manages:
- **Task dependencies** — topological sort based on "Blocked by" references
- **Todo status** — closes tasks and updates the PRD Task Index automatically
- **Git commits** — simple auto-commit per task, or granular conventional commits via `--smart-commits`
- **Retries** — failed tasks get retried with error context from the previous attempt
- **Abort handling** — Ctrl+C kills the current subagent, stops the loop, leaves code on disk

#### Subagents

The extension uses two specialized agent definitions:

| Agent | File | Purpose |
|-------|------|---------|
| `prd-worker` | `agents/prd-worker.md` | Implements a task, validates acceptance criteria, returns JSON result |
| `prd-committer` | `agents/prd-committer.md` | Analyzes `git diff`, creates granular conventional commits (smart-commits mode) |

### 4 (alt.). PRD Loop Pro — Execute with review-fix pipeline

`/prd-loop-pro` (alias `/ralph-pro`) is the pipeline variant of `/prd-loop`. Both can be used in parallel; pick
`/prd-loop-pro` when every task should be reviewed and fixed before it is committed.

```
/prd-loop-pro prd-1
```

`prd-N` is the only argument — there are no flags. Full reference:
[extensions/prd-loop-pro/README.md](../extensions/prd-loop-pro/README.md).

#### Pipeline per task

```
Implement → Review ⇄ Fix → Commit → Report
```

1. **Implement** — `prd-worker` implements the task in an isolated subagent (with optional automatic retries).
2. **Review** — a fresh `prd-reviewer` reviews the uncommitted changes (excluding `.pi/`) with the same rubric as
   `/review`, and also checks completeness against the task's acceptance criteria and out-of-scope changes.
3. **Fix** — one fresh `prd-fixer` per review round for all findings at/above the fix threshold (P0 first). It fixes
   each valid finding or rejects it with a reason, and runs the relevant checks once after all fixes.
4. **Re-review** — only if at least one finding was fixed; rejected findings and their reasons are passed to the next
   reviewer so they aren't raised again. Ends when no findings at/above the threshold remain, all were rejected, or
   the round limit is reached (→ pause).
5. **Commit** — `prd-committer` creates small Conventional Commits following the `/commit` prompt template (no
   `Refs:`/`Task:` footers, never bypasses hooks).
6. **Report** — an `## Execution Report` (rounds, fixed/rejected/deferred findings, callouts, commits, cost) is appended
   to the task todo, the todo is closed and the PRD Task Index is updated.

Findings below the threshold are not fixed; they are recorded as deferred findings in the execution report.

#### Settings

Instead of flags, `/prd-loop-pro` uses saved settings: model + thinking level for each step (implement, review, fix,
commit, orchestrator for JSON repair), fix threshold (`P0`–`P3`, default `P1`), max review rounds (default `3`) and
implementation retries (default `0`).

- **First start:** a setup wizard walks through all settings and saves them globally
  (`~/.pi/agent/prd-loop-pro.json`).
- **Per project:** individual fields can be overridden in `.pi/prd-loop-pro.json` (only the differing fields are
  stored).
- **Every start:** an overview shows the PRD, task counts and all settings with their source (`[global]`/`[project]`).
  The cursor starts on *Confirm & start*; move up to change an entry in place. With unsaved changes, start via
  *Save globally & start* or *Save for this project only & start* (or discard them). Unavailable models or invalid
  thinking levels are marked ⚠️ and block the start.

#### Pauses and `needs-human`

The loop never fails hard. When the round limit is reached, the implementation still fails after all retries, a
subagent result can't be repaired into valid JSON, the committer or a git hook fails, or you press `Ctrl+C`, it opens
a pause menu (e.g. *Resume*, *Retry phase*, *Retry task*, *One more round*, *Commit as-is*, *Skip task*, *Abort*).
Discarding changes never touches `.pi/`.

**Release (fix manually)** sets the task todo to `needs-human`, appends the open findings to it and stops the loop. The
task and its dependents stay blocked. Fix it manually (or with the main agent), then run `/prd-loop-pro` again: the
`needs-human` task is offered first with *Commit changes (committer) & close*, *Already committed – just close* or
*Review again* — uncommitted changes are allowed for this — and the loop then continues with the next task.

## Alternative Entry Points

You don't have to follow the full chain every time:

### Start from `/todos`

Open `/todos`, select a **PRD** todo, and say "work". The agent reads the Task Index in the PRD body and can work
through individual tasks — though for full autonomous execution, use `/prd-loop`.

### Start from a single task

Open `/todos`, select a specific **task** (e.g., `PRD #1 - Task 3/4: ...`), and say "work". The agent checks its
blockers, and either starts working or tells you which tasks need to be done first.

### Skip dialogs for CI/automation

Use flags to run non-interactively:

```
/prd-loop prd-1 --retry-fixes=2 --smart-commits --model=anthropic/claude-sonnet-4-5
```

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

Then come back later and run `/prd-loop` to pick which PRD to implement.

## How Status Tracking Works

Status is synchronized in **two places** for resilience:

| Source of Truth | What | Updated by |
|----------------|------|-----------|
| **Individual task todos** (status field) | Whether a task is open/closed (or `needs-human` with `/prd-loop-pro`) | `/prd-loop` / `/prd-loop-pro` after each task |
| **PRD Task Index** (in PRD body) | Dashboard view with dependencies + status | `/prd-loop` / `/prd-loop-pro` at start + after each task |

The Task Index gets updated from the actual task statuses after each completed task. This means it works correctly even
if:

- A previous run was aborted mid-task
- Someone closes a task manually
- Tasks are worked on across multiple sessions
- You resume after an interruption (closed tasks are skipped automatically)
