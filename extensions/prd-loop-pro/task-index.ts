/**
 * PRD Loop Pro — Task graph, `needs-human` handling and PRD Task Index
 * (pure, no pi imports).
 *
 * - Task status helpers (`closed`/`done` = closed, `needs-human` = released
 *   to a human: not closed, not actionable).
 * - Dependency resolution (Kahn's algorithm). `needs-human` tasks and every
 *   task that (transitively) depends on one are held back: they are never
 *   started by the loop until the `needs-human` task is resolved.
 * - PRD Task Index sync (status column + "Next up" pointer), showing
 *   `needs-human` tasks distinctly.
 * - Git clean check with the `needs-human` resolve exception.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

/** Todo status of a task released to a human ("Release (fix manually)"). */
export const NEEDS_HUMAN_STATUS = "needs-human";

/** Status cell labels of the PRD Task Index. */
export const INDEX_STATUS_LABELS = {
	closed: "✅ done",
	ready: "🔓 ready",
	blocked: "⏳ blocked",
	needsHuman: "🔧 needs-human",
} as const;

export interface TaskInfo {
	id: string;
	title: string;
	status: string;
	body: string;
	blockedBy: string[];
	sequenceLabel: string; // e.g. "1/8"
}

/**
 * Check whether a task status represents a completed/closed state.
 * Recognises "closed" (set by the loop) and "done" (set manually or by other tools).
 * `needs-human` is NOT closed.
 */
export function isTaskClosed(status: string): boolean {
	return status === "closed" || status === "done";
}

/** True if the task was released to a human and waits for manual resolution. */
export function isNeedsHuman(status: string): boolean {
	return status === NEEDS_HUMAN_STATUS;
}

/**
 * Parse the "Blocked by" section from a task body to extract blocker TODO-IDs.
 *
 * Handles:
 * - "None — can start immediately" → []
 * - "- TODO-abc123 (PRD #1 - Task 1/8: ...)" → ["TODO-abc123"]
 * - Multiple "- TODO-xxx" lines → ["TODO-xxx", ...]
 */
export function parseBlockedBy(body: string): string[] {
	const blockers: string[] = [];

	// Find the "## Blocked by" section
	const sectionMatch = body.match(/##\s*Blocked by\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/i);
	if (!sectionMatch) return blockers;

	const section = sectionMatch[1]!;

	// Check for "None" indicator
	if (/none/i.test(section) && /can start/i.test(section)) {
		return blockers;
	}

	// Extract TODO-IDs from list items
	const todoIdPattern = /TODO-([0-9a-f]+)/gi;
	let match: RegExpExecArray | null;
	while ((match = todoIdPattern.exec(section)) !== null) {
		blockers.push(`TODO-${match[1]}`);
	}

	return blockers;
}

export interface TaskResolutionResult {
	/** Ordered list of open, actionable tasks to execute */
	actionable: TaskInfo[];
	/** All tasks (including closed and blocked) */
	allTasks: TaskInfo[];
	/**
	 * Open tasks the loop must not start: `needs-human` tasks and all tasks that
	 * (transitively) depend on one. Ordered like `allTasks`.
	 */
	held: TaskInfo[];
	/** Error message if circular dependency detected */
	error?: string;
}

export interface ResolveOptions {
	/**
	 * A `needs-human` task that is being resolved in this run ("Commit changes"
	 * / "Review again"). It is treated as open (not held), so it and its
	 * dependents become actionable.
	 */
	resolvingTaskId?: string;
}

/**
 * Resolve task dependencies and produce an ordered execution list.
 *
 * Uses Kahn's algorithm (BFS topological sort):
 * 1. Build adjacency list and in-degree count from dependency relationships
 * 2. Start with tasks that have no unresolved dependencies
 * 3. Process tasks in topological order
 * 4. Skip closed tasks (they're already done)
 * 5. Detect circular dependencies
 * 6. Hold back `needs-human` tasks and their (transitive) dependents
 *
 * A dependency is "resolved" if the blocker task is closed. A `needs-human`
 * blocker is not closed, so its dependents stay blocked.
 */
export function resolveTaskOrder(tasks: TaskInfo[], options: ResolveOptions = {}): TaskResolutionResult {
	const taskMap = new Map<string, TaskInfo>();
	for (const task of tasks) {
		taskMap.set(task.id, task);
	}

	// Filter to open tasks only (needs-human counts as open)
	const openTasks = tasks.filter((t) => !isTaskClosed(t.status));

	if (openTasks.length === 0) {
		return { actionable: [], allTasks: tasks, held: [] };
	}

	// Build in-degree count for open tasks only
	// A dependency counts toward in-degree ONLY if the blocker is also open
	// (closed blockers are already satisfied)
	const inDegree = new Map<string, number>();
	const dependents = new Map<string, string[]>(); // blocker → [tasks that depend on it]

	for (const task of openTasks) {
		inDegree.set(task.id, 0);
	}

	for (const task of openTasks) {
		for (const blockerId of task.blockedBy) {
			const blocker = taskMap.get(blockerId);

			// If blocker doesn't exist in this PRD or is closed, it's resolved
			if (!blocker || isTaskClosed(blocker.status)) {
				continue;
			}

			// Blocker is open → this creates a real dependency
			inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);

			if (!dependents.has(blockerId)) {
				dependents.set(blockerId, []);
			}
			dependents.get(blockerId)!.push(task.id);
		}
	}

	// Kahn's algorithm
	const queue: string[] = [];
	for (const task of openTasks) {
		if ((inDegree.get(task.id) || 0) === 0) {
			queue.push(task.id);
		}
	}

	const sorted: TaskInfo[] = [];

	while (queue.length > 0) {
		const taskId = queue.shift()!;
		const task = taskMap.get(taskId)!;
		sorted.push(task);

		const deps = dependents.get(taskId) || [];
		for (const depId of deps) {
			const newDegree = (inDegree.get(depId) || 1) - 1;
			inDegree.set(depId, newDegree);
			if (newDegree === 0) {
				queue.push(depId);
			}
		}
	}

	// Circular dependency detection
	if (sorted.length < openTasks.length) {
		const stuck = openTasks
			.filter((t) => !sorted.some((s) => s.id === t.id))
			.map((t) => t.title)
			.join(", ");
		return {
			actionable: [],
			allTasks: tasks,
			held: [],
			error: `Circular dependency detected among tasks: ${stuck}`,
		};
	}

	// Hold back needs-human tasks (except the one being resolved) and their
	// transitive dependents.
	const heldIds = new Set<string>();
	const pending = openTasks
		.filter((t) => isNeedsHuman(t.status) && t.id !== options.resolvingTaskId)
		.map((t) => t.id);
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (heldIds.has(id)) continue;
		heldIds.add(id);
		for (const depId of dependents.get(id) || []) pending.push(depId);
	}

	const actionable = sorted.filter((t) => !heldIds.has(t.id));

	// The task being resolved runs first (its blockers are closed, so this
	// keeps a valid topological order).
	if (options.resolvingTaskId) {
		const index = actionable.findIndex((t) => t.id === options.resolvingTaskId);
		if (index > 0) actionable.unshift(...actionable.splice(index, 1));
	}

	return {
		actionable,
		allTasks: tasks,
		held: openTasks.filter((t) => heldIds.has(t.id)),
	};
}

/** Index status label of a task given the set of closed task IDs. */
function indexStatusLabel(task: TaskInfo, closedIds: Set<string>): string {
	if (isTaskClosed(task.status)) return INDEX_STATUS_LABELS.closed;
	if (isNeedsHuman(task.status)) return INDEX_STATUS_LABELS.needsHuman;
	if (task.blockedBy.every((b) => closedIds.has(b))) return INDEX_STATUS_LABELS.ready;
	return INDEX_STATUS_LABELS.blocked;
}

/**
 * Sync the PRD Task Index body with the actual todo statuses.
 *
 * Called at loop start (so that tasks completed outside the loop are
 * reflected) and after every status change of a task (closed, needs-human).
 *
 * For each table row referencing a TODO-xxx:
 * - Closed/done tasks           → "✅ done"
 * - `needs-human` tasks         → "🔧 needs-human"
 * - Open, all blockers resolved → "🔓 ready"
 * - Open, unresolved blockers   → "⏳ blocked" (also while a blocker is `needs-human`)
 *
 * Also updates the "Next up:" / "Start with:" pointer: the next actionable
 * task, otherwise the first `needs-human` task (marked as such).
 */
export function syncPrdTaskIndex(body: string, allTasks: TaskInfo[]): string {
	const taskMap = new Map<string, TaskInfo>();
	for (const t of allTasks) {
		taskMap.set(t.id, t);
	}

	const closedIds = new Set<string>();
	for (const t of allTasks) {
		if (isTaskClosed(t.status)) closedIds.add(t.id);
	}

	const lines = body.split("\n");
	const updatedLines: string[] = [];

	for (const line of lines) {
		const todoMatch = line.match(/TODO-[0-9a-f]+/i);
		// Table data rows have multiple pipes and a TODO reference
		const pipeCount = (line.match(/\|/g) || []).length;
		const isTableRow = pipeCount >= 4 && todoMatch;

		if (isTableRow && todoMatch) {
			const taskId = todoMatch[0];
			const task = taskMap.get(taskId);

			if (!task) {
				updatedLines.push(line);
				continue;
			}

			// Replace the last meaningful cell (Status column)
			const cells = line.split("|");
			const statusCellIndex = cells.length - 2; // last cell before the trailing pipe

			if (statusCellIndex < 1) {
				updatedLines.push(line);
				continue;
			}

			cells[statusCellIndex] = ` ${indexStatusLabel(task, closedIds)} `;
			updatedLines.push(cells.join("|"));
		} else if (/^(Next up|Start with)\s*:/i.test(line)) {
			// Update the pointer to the next actionable task
			const nextTask = allTasks
				.filter((t) => !isTaskClosed(t.status) && !isNeedsHuman(t.status))
				.find((t) => t.blockedBy.every((b) => closedIds.has(b)));
			const needsHuman = allTasks.find((t) => isNeedsHuman(t.status));

			if (nextTask) {
				updatedLines.push(`Next up: **${nextTask.id}** (${nextTask.title})`);
			} else if (needsHuman) {
				updatedLines.push(`Next up: **${needsHuman.id}** (${needsHuman.title}) — ${INDEX_STATUS_LABELS.needsHuman}, resolve via /prd-loop-pro`);
			} else if (allTasks.every((t) => isTaskClosed(t.status))) {
				updatedLines.push(`Next up: All tasks completed! 🎉`);
			} else {
				updatedLines.push(line);
			}
		} else {
			updatedLines.push(line);
		}
	}

	return updatedLines.join("\n");
}

export type GitCleanCheck =
	| { ok: true; dirty: boolean }
	| { ok: false; error: string };

/**
 * Git clean check at start. Uncommitted changes are only allowed while a
 * `needs-human` task is being resolved (they are the human's work on that
 * task); every other dirty state fails the check.
 *
 * @param porcelain - output of `git status --porcelain`
 * @param resolvingNeedsHuman - true if a `needs-human` task is resolved with the
 *   current changes ("Commit changes & close" / "Review again")
 */
export function checkGitClean(porcelain: string, resolvingNeedsHuman: boolean): GitCleanCheck {
	const dirty = porcelain.trim() !== "";
	if (!dirty || resolvingNeedsHuman) return { ok: true, dirty };
	return {
		ok: false,
		error:
			"Uncommitted changes detected. Please clean your working directory before starting the loop " +
			"(uncommitted changes are only allowed while resolving a needs-human task via " +
			"\"Commit changes & close\" or \"Review again\").",
	};
}
