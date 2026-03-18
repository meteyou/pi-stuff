---
name: work-on-prd
description: Work through all tasks of a specific PRD sequentially. Use when user wants to start working on a PRD, execute PRD tasks, implement a PRD, or says "work on PRD #N". Lists available PRDs if no number specified.
---

# Work on PRD

Execute all tasks of a specific PRD in dependency order.

## Process

### 1. Identify the PRD

If the user specified a PRD number (e.g., "work on PRD #2"), use it directly. Otherwise, list all todos with tag `prd` and ask the user which PRD to work on.

### 2. Load the PRD and its tasks

1. Fetch the PRD todo — its body contains a **Task Index** table with all task TODO-IDs
2. Fetch **every** task todo listed in the Task Index using the todo tool (by ID)
3. For each task, note its current `status` (open/closed) and extract `## Blocked by` from the body
4. Sort tasks by their sequence number from the title (`Task M/T`)

If no open tasks remain, report that all tasks are completed and close the PRD todo.

### 3. Sync the PRD Task Index

Before starting work, **update the Task Index** in the PRD todo body to reflect current reality. For each task row, set the status column based on the actual todo status:

```
| 1/4 | Database Schema & Models    | TODO-abc123 | —           | ✅ closed  |
| 2/4 | Auth API Endpoints          | TODO-def456 | TODO-abc123 | 🔄 open   |
| 3/4 | Login UI & Session Handling | TODO-ghi789 | TODO-def456 | ⏳ blocked |
| 4/4 | E2E Tests & Error Handling  | TODO-jkl012 | TODO-ghi789 | ⏳ blocked |
```

Update the "Start with" line to point to the next actionable task.

This ensures the PRD todo always shows the current state, even across sessions.

### 4. Find the next task

Select the next task to work on using this logic:

1. Filter to `open` tasks only (skip `closed` tasks)
2. For each open task, check its `## Blocked by` section
3. A task is **actionable** if all its blockers are `closed`
4. Pick the actionable task with the lowest sequence number (M)

If no task is actionable (all open tasks are blocked by other open tasks), report the deadlock and ask the user for guidance.

### 5. Work on the task

1. Claim the task via the todo tool
2. Read the parent PRD todo for full context (skip the Task Index, focus on the PRD content below `---`)
3. Read the task body for acceptance criteria and scope
4. Implement the task
5. Verify all acceptance criteria are met
6. Mark the task as `closed` via the todo tool

### 6. Update PRD Task Index after completion

After closing a task, immediately update the PRD todo body:
- Set the completed task's status to `✅ closed`
- Check if previously blocked tasks are now unblocked (all their blockers are closed)
- Update those to `🔄 open`
- Update the "Start with" line to point to the next actionable task

### 7. Continue or stop

After completing a task and updating the PRD, report progress (completed count, total count, next task). Then ask if the user wants to continue with the next task.

- If the user confirms → go to step 4
- If all tasks are done → close the PRD todo itself
