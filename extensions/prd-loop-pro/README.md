# PRD Loop Pro Extension

Autonomous PRD task orchestrator with a **review-fix pipeline per task** and **saved per-step settings**. Started as a
copy of [`prd-loop`](../prd-loop/index.ts); the original stays unchanged and can be used in parallel. Part of the
[PRD Workflow](../../docs/prd-workflow.md).

Compared to `/prd-loop`:

- every task is **reviewed** (same rubric as `/review` plus completeness against the task) and review findings are
  **fixed** by dedicated subagents before anything is committed
- each agent step has its **own model + thinking level**, saved globally and optionally per project — no CLI flags
- the loop never fails hard: whenever automation gets stuck it **pauses** and hands control to you, and a task can be
  **released to a human** (`needs-human`) and resumed at the next start
- invalid subagent JSON is **repaired** (deterministically, then via the orchestrator model) instead of aborting the run
- commits are always clean Conventional Commits made by a committer agent (no simple fallback commit, no
  `Refs:`/`Task:` footers)

## Commands

| Command | Description |
|---------|-------------|
| `/prd-loop-pro [prd-N]` | Run the pipeline for all open tasks of a PRD |
| `/ralph-pro [prd-N]` | Alias for `/prd-loop-pro` |

`prd-N` is the only argument. Without it, a dialog lets you pick a PRD with open tasks. All other configuration lives
in the saved [settings](#settings).

## Start Sequence

1. **Git status** — the working tree must be clean (`.pi/` is ignored). Exception: uncommitted changes are allowed
   while resolving a `needs-human` task (they are assumed to be your manual work on it).
2. **Commit rules** — loaded from the package's [`/commit` prompt template](../../prompts/commit.md) (frontmatter
   stripped). A missing or empty template is a hard error.
3. **`needs-human` tasks first** — see [Needs-Human Resume Flow](#needs-human-resume-flow).
4. **PRD selection** — argument, dialog, or the PRD of the resolved `needs-human` task.
5. **Settings** — first start: setup wizard; afterwards global settings merged with project overrides and validated.
6. **Overview** — PRD, task counts and all settings; select an entry to change it, then `Confirm & start`.
7. **Orchestrator loop** — runs the [pipeline](#pipeline) for each task in dependency order (topological sort over the
   tasks' "Blocked by" references).

## Pipeline

Every task runs through the following phases, each in a **fresh, isolated `pi` subprocess**:

```
Implement → Review ⇄ Fix → Commit → Report
```

| Phase | Agent | What happens |
|-------|-------|--------------|
| **Implement** | `prd-worker` | Implements the task, validates acceptance criteria, runs tests/build/lint. Retried automatically up to *Implementation retries* times with the previous errors as context. |
| **Review** | `prd-reviewer` | Reviews the uncommitted changes (excluding `.pi/`) with the shared `/review` rubric, the project's `REVIEW_GUIDELINES.md` (if any) and the task title/body. Also reports missing/partial acceptance criteria and out-of-scope changes. Each round uses a fresh reviewer. |
| **Fix** | `prd-fixer` | One fresh fixer **per review round** for all findings at/above the [fix threshold](#fix-threshold--round-limit) (listed P0 first). It fixes each valid finding, rejects the others with a reason and runs the relevant checks **once** after all fixes. It reports fixed/rejected per finding. |
| **Commit** | `prd-committer` | Commits the changes (excluding `.pi/`) as small Conventional Commits following the `/commit` template. Never bypasses hooks. |
| **Report** | — (orchestrator) | Appends a deterministic `## Execution Report` to the task todo, closes it and updates the PRD Task Index (closes the PRD when all tasks are closed). |

### Review-fix cycle

```
review → findings ≥ threshold? ──no──────────────────────────────▶ commit
            │ yes
            ▼
        fix all (1 fixer) → ≥1 fixed? ──no (all rejected/unresolved)──▶ commit
                                │ yes
                                ▼
                            review again (next round)
```

- **Below-threshold findings** are never fixed; they are recorded as *deferred* findings in the execution report.
- **Rejected findings** (with the fixer's reason) are passed to the next review prompt. The reviewer must not raise
  them again unless it explicitly disagrees with the reason.
- **Unresolved findings** — findings the fixer returns no result for stay unresolved. A fixer that crashes or returns
  no valid result (even after [JSON repair](#json-repair)) pauses the loop, because its partial changes would
  otherwise be committed without a re-review.
- A **re-review** only happens if at least one finding of the round was fixed.
- **Round limit** — if review round *Max review rounds* still reports findings at/above the threshold, the loop pauses
  (see [Pause Cases](#pause-cases)) instead of fixing them blindly.
- **Human reviewer callouts** (migrations, new/changed dependencies, auth changes, breaking API changes, destructive
  operations) are recorded in the report.

### Execution report

Appended to the task todo after the task is committed (or closed via a pause/resume option). Contains the implementer
summary, review rounds, fixed findings, rejected findings with reasons, deferred findings, unresolved findings, human
reviewer callouts, the created commit SHAs (HEAD before vs. after the commit phase, determined by the orchestrator) and
the cost per phase (implement, review, fix, commit, JSON repair).

## Settings

### Steps and fields

| Setting | Values | Default |
|---------|--------|---------|
| `steps.implement` | model (`provider/model-id`) + thinking level | session model + thinking level |
| `steps.review` | model + thinking level | session model + thinking level |
| `steps.fix` | model + thinking level | session model + thinking level |
| `steps.commit` | model + thinking level | session model + thinking level |
| `steps.orchestrator` | model + thinking level (used for JSON repair) | session model + thinking level |
| `fixThreshold` | `P0` (only P0), `P1` (≤ P1), `P2` (≤ P2), `P3` (≤ P3) | `P1` |
| `maxReviewRounds` | integer ≥ 1 | `3` |
| `implementationRetries` | integer ≥ 0 | `0` |

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` — only those supported by the selected model;
non-reasoning models only offer `off`.

### Global and project settings

| Scope | File | Contents |
|-------|------|----------|
| Global | `<pi agent dir>/prd-loop-pro.json` (e.g. `~/.pi/agent/prd-loop-pro.json`) | Complete settings incl. `version` |
| Project | `<project>/.pi/prd-loop-pro.json` | Only the overridden fields |

Project overrides are merged **per field** over the global settings (a step's model + thinking level are overridden
together). Example project file:

```json
{
  "version": 1,
  "steps": {
    "review": { "model": "anthropic/claude-opus-4-1", "thinking": "high" }
  },
  "fixThreshold": "P2"
}
```

### First start: setup wizard

Without a global settings file, a wizard walks through all entries (model + thinking for each of the five steps, fix
threshold, max review rounds, implementation retries), pre-filled with the current session model and thinking level.
The result is saved globally. If the global file is invalid, you're offered to re-run the wizard (overwrites the file).

### Overview

Every start shows one overview menu with the PRD, open/completed task counts, the paths of both settings files and
every entry with its source (`[global]` or `[project]`). The cursor starts on **Confirm & start**; move up with `↑` to
select an entry and change it in place (model + thinking for steps, the fix threshold, max review rounds and
implementation retries). The model picker lists your scoped models first and offers **All available models…** as last
option, so steps can mix providers. Changed entries are marked `• changed` and the cursor stays on the edited row.

Actions:

| Action | Shown | Effect |
|--------|-------|--------|
| Confirm & start | no unsaved changes | Starts the loop |
| Save globally & start | unsaved changes | Writes the edited values to the global file, then starts |
| Save for this project only & start | unsaved changes | Writes only the fields that differ from global to `.pi/prd-loop-pro.json` (removes the file if nothing differs), then starts |
| Discard changes | unsaved changes | Reverts the edits |
| Remove project overrides | overrides exist or the project file is invalid | Deletes the project file; the project uses the global settings again |
| Cancel | always | Does not start (asks before dropping unsaved changes) |

At start, each configured model must still be available (API key configured) and each thinking level must be valid for
its model; numbers must be in range. Invalid entries are marked with ⚠️ and starting is blocked until they are fixed.
An invalid project file blocks *Save globally & start*, but can be overwritten via *Save for this project only & start*.

### Changing models while the loop runs

Press `s` in the live overlay to change the **model + thinking level** of any step (implement, review, fix, commit,
orchestrator) without stopping the loop. The overlay is hidden while the dialog is open; the loop keeps running in the
background and the overlay comes back when you confirm or leave the dialog.

- Every subagent reads its step's model + thinking level **when it starts**. A running subagent is never interrupted
  and keeps the model it was started with; the change applies from the next start of that step (e.g. the next fixer
  of the current task, or a *Retry phase*). The orchestrator model applies to the next JSON repair.
- The dialog shows which subagent is running right now (and with which model). Edited rows are marked `• changed`.
- Actions with unsaved changes: **Apply to this run** (not saved), **Apply & save globally**, **Apply & save for this
  project only** (only the steps edited in this dialog are written; earlier run-only edits stay unsaved) and
  **Discard changes & back to loop**. `Esc` returns to the loop (asks before dropping unsaved changes).
- If the loop needs a pause menu while the dialog is open, the pause menu is shown right after the dialog closes.
- Fix threshold, max review rounds and implementation retries can only be changed at start.

The model each subagent run used is shown in the output viewer's phase headers and, while it runs, in the task
details (`Model:`).

## Fix Threshold & Round Limit

- **Fix threshold** is an inclusive upper bound: `P1` fixes all P0 and P1 findings, P2/P3 findings are deferred.
  `P3` fixes everything, `P0` only blockers.
- **Max review rounds** limits review rounds per task (default 3). Reaching it with findings still at/above the
  threshold opens the round-limit pause menu; **One more round** raises the limit by one for this task.

## Pause Cases

The loop never fails hard on a task. Instead, it opens a pause menu that shows the task, the current phase (incl.
progress, e.g. `Review 2/3` or `Fix #1 • 3 findings`), the reason and any errors/details:

| Reason | Options |
|--------|---------|
| Manual pause (`Ctrl+C`) | Resume current phase, Skip phase\*, Retry task, Release, Skip task, Abort |
| Implementation failed after all retries | Retry task, Release, Skip task, Abort |
| JSON repair failed (no valid subagent result) | Retry phase, Release, Skip task, Abort |
| Phase failed (reviewer/fixer crashed, git error, …) | Retry phase, Release, Skip task, Abort |
| Committer failed | Retry phase, Release, Skip task, Abort |
| Git hook failed (e.g. pre-commit) | Retry phase, Release, Skip task, Abort |
| Review round limit reached (lists open findings: priority, `file:line`, title) | One more round, Commit as-is & close task, Release, Skip task, Abort |

\* *Skip phase* is not offered during the commit phase — uncommitted changes would leak into the next task.

| Option | Effect |
|--------|--------|
| Resume current phase | Keep changes and continue/restart the paused phase |
| Skip phase | Keep changes and move on (implement → review, review → commit, fix → open findings unresolved, commit) |
| Retry phase | Keep changes and run the phase's agent again |
| Retry task | Discard changes (except `.pi/`) and restart at implement |
| One more round | Fix the open findings and review again |
| Commit as-is & close task | Commit; open findings go into the report as unresolved |
| Release (fix manually) | Mark the task `needs-human`, append open findings, stop the loop |
| Skip task | Discard changes (except `.pi/`), mark the task done, continue with the next one |
| Abort | Stop the loop, keep changes on disk |

Discard operations never touch `.pi/` — todos, execution reports and settings are never lost, even if `.pi/` is
tracked by git. The committer never uses `--no-verify` and never tries to fix hook failures; it reports
`hookFailed: true` and the loop pauses so you can resolve the hook problem.

## Needs-Human Resume Flow

**Release (fix manually)** is available in every pause menu:

1. The task todo status is set to `needs-human` and an `## Open Findings` section (open/unresolved findings, rejected
   findings with reasons, release reason and errors) is appended to the todo.
2. The PRD Task Index shows the task as `🔧 needs-human`.
3. The loop stops; uncommitted changes stay on disk.

`needs-human` is **not** closed: the task and all tasks depending on it are held back until it is resolved. Fix the
open findings manually (or with the main agent), then run `/prd-loop-pro` again. Before PRD selection, every
`needs-human` task is offered first (with several tasks, you pick one):

| Option | Effect |
|--------|--------|
| Commit changes (committer) & close | Runs only the commit phase on the current changes, then report + close |
| Already committed – just close | Appends an execution report, closes the task and updates the PRD Task Index |
| Review again | Runs the review-fix cycle on the current changes, then commit + close |
| Not now | Leaves the task as `needs-human` |

The git clean check allows uncommitted changes while a `needs-human` task is being resolved. Afterwards the loop
continues with the next task of the PRD.

## UI

- **Live overlay** — task rows show the current phase and round (e.g. `Review 2/3`, `Fix #1 • 3 findings`). Expanded
  task details show the review round counter, fixed/rejected/deferred/unresolved counts and the cost per phase.
  Keys: `↑/↓` select (long task details are scrolled through line by line first), `Enter` expand, `←` collapse,
  `a` expand/collapse all, `o` output viewer, `s` change models/thinking while running (see
  [Changing models while the loop runs](#changing-models-while-the-loop-runs)), `Ctrl+C` pause, `Esc` (twice) abort.
- **Output viewer** (`o`) — events grouped per subagent run under phase headers (`Implement`, `Review #1`,
  `Fix #1 • 3 findings`, `Commit`) with the model + thinking level of the run, outcome, cost and duration.
- **Finished view** — when the run is over (completed, failed, aborted by a pause action or released), the overlay
  stays open: the header shows the outcome, totals and the final notification; tasks can still be expanded and their
  output inspected. `Esc`/`q` closes it.
- **Summary entry** — closing the overlay posts the summary to the chat as a custom session entry (persisted in the
  session, never sent to the LLM). Collapsed it shows the headline, tasks that need attention (⚠️ `needs-human`,
  failed, aborted) and the totals; `Ctrl+O` expands it to all tasks with rounds and finding counts.

## Agents

Agent definitions live in [`agents/`](./agents). Each agent ends its run with a **raw JSON object as its final
message**.

| Agent | Step | Tools | Result contract |
|-------|------|-------|-----------------|
| [`prd-worker`](./agents/prd-worker.md) | Implement | read, bash, write, edit | `{ success, errors[], summary }` |
| [`prd-reviewer`](./agents/prd-reviewer.md) | Review | read, bash, grep, find, ls (read-only) | `{ verdict: "correct" \| "needs attention", summary, findings: [{ priority: "P0".."P3", title, file, line?, body }], callouts: [string] }` |
| [`prd-fixer`](./agents/prd-fixer.md) | Fix | read, bash, edit, write | `{ results: [{ id, status: "fixed" \| "rejected", reason, summary }], verification }` (one entry per finding) |
| [`prd-committer`](./agents/prd-committer.md) | Commit | read, bash | `{ success, errors[], summary, hookFailed }` |

Rules shared by all agents: never touch `.pi/`, never use the todo tool. Worker, reviewer and fixer never run git write
operations; only the committer commits (explicit paths, no `git add -A`, no `--no-verify`, no footers).

### JSON repair

Subagent results are parsed in two steps:

1. **Deterministic** — strip code fences, extract balanced JSON objects (last valid one wins), fix trailing commas and
   raw control characters, validate against the agent's schema.
2. **LLM repair** — if that fails, the orchestrator model (no tools) gets the expected schema plus the raw output and
   must return JSON only. Its answer is validated again; the cost is reported as *JSON repair*.

If both fail, the loop pauses (*JSON repair failed*).

## Modules

| File | Purpose |
|------|---------|
| `index.ts` | Commands, start flow, orchestrator loop, subagent runner, overlay |
| `settings.ts` | Settings schema, load/merge/save (global, project-only, remove overrides), validation (pure) |
| `settings-ui.ts` | Setup wizard, overview menu (edit entries in place, save & start), run settings dialog (`s` while running), model/thinking pickers |
| `overview-menu.ts` | Overview menu and run settings menu models: title, rows and actions (pure) |
| `subagent-result.ts` | Result schemas, deterministic parsing and LLM repair (pure) |
| `review-cycle.ts` | Review-fix cycle state machine (pure) |
| `reviewer-prompt.ts`, `fixer-prompt.ts`, `committer-prompt.ts` | Prompt builders (reviewer uses the shared [review rubric](../review/review-prompts.ts)) |
| `execution-report.ts` | Execution report and open-findings sections (pure) |
| `pause.ts` | Pause reasons, menu options and labels (pure) |
| `task-index.ts` | Task graph, `needs-human` handling, PRD Task Index sync, git clean check (pure) |
| `discard.ts` | Discard uncommitted changes except `.pi/` |
| `progress-view.ts` | View model for overlay, output viewer and summary entry (pure) |

## Tests

The pure modules are unit-tested with Node's built-in test runner (native TypeScript type stripping, no extra
dependencies). Run from the repository root:

```bash
npm test
```
