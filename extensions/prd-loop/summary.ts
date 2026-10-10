/**
 * Final run summary of the PRD loop (pure, no pi imports).
 *
 * Used for the finished overlay header and for the summary entry that is
 * posted to the chat after the overlay is closed.
 */

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "retrying" | "aborted";

export type SummaryOutcome = "completed" | "failed" | "aborted";

export interface SummaryTask {
	/** `Task 3/11: Short title` */
	label: string;
	status: TaskStatus;
	/** Time spent on the task (if it ran to an end). */
	elapsedMs?: number;
	cost: number;
	retries: number;
}

export interface SummaryInput {
	prdTitle: string;
	outcome: SummaryOutcome;
	tasks: SummaryTask[];
	totalElapsedMs: number;
	totalCost: number;
	totalCommits: number;
}

/** Format elapsed milliseconds as `M:SS`. */
export function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

/** Status icon of a task. */
export function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "pending": return "⏳";
		case "running": return "🔄";
		case "completed": return "✅";
		case "failed": return "❌";
		case "retrying": return "🔁";
		case "aborted": return "⚠️";
	}
}

const OUTCOME_ICONS: Record<SummaryOutcome, string> = { completed: "✅", failed: "❌", aborted: "⚠️" };
const OUTCOME_TEXTS: Record<SummaryOutcome, string> = {
	completed: "Loop completed",
	failed: "Loop failed",
	aborted: "Loop aborted",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Outcome text without the PRD title: `✅ Loop completed`. */
export function buildOutcomeLabel(outcome: SummaryOutcome): string {
	return `${OUTCOME_ICONS[outcome]} ${OUTCOME_TEXTS[outcome]}`;
}

/** Summary headline: `✅ <PRD title> — Loop completed`. */
export function buildSummaryHeadline(input: Pick<SummaryInput, "prdTitle" | "outcome">): string {
	return `${OUTCOME_ICONS[input.outcome]} ${input.prdTitle} — ${OUTCOME_TEXTS[input.outcome]}`;
}

/** One summary row: `Task 1/3: Title  ✅   6:33  $1.93  (1 retry)`. */
export function buildSummaryTaskLine(task: SummaryTask): string {
	const timePart = task.elapsedMs !== undefined ? formatElapsed(task.elapsedMs).padStart(5) : "     ";
	const costPart = task.cost > 0 ? `  $${task.cost.toFixed(2)}` : "";
	const retryPart = task.retries > 0 ? `  (${plural(task.retries, "retry", "retries")})` : "";
	return `${task.label}  ${statusIcon(task.status)}  ${timePart}${costPart}${retryPart}`;
}

/** Totals row: `Total: 1:02:03 | $3.50 | 1 retry | 4 commits`. */
export function buildSummaryTotalsLine(input: SummaryInput): string {
	const totalRetries = input.tasks.reduce((sum, t) => sum + t.retries, 0);
	return [
		`Total: ${formatElapsed(input.totalElapsedMs)}`,
		`$${input.totalCost.toFixed(2)}`,
		plural(totalRetries, "retry", "retries"),
		plural(input.totalCommits, "commit"),
	].join(" | ");
}

/** Tasks that still need attention after a run; they stay visible in the collapsed summary entry. */
export function taskNeedsAttention(status: TaskStatus): boolean {
	return status === "failed" || status === "aborted";
}

export type SummaryEntryLineKind = "headline" | "task" | "totals" | "hint" | "blank";

export interface SummaryEntryLine {
	kind: SummaryEntryLineKind;
	text: string;
	/** Task status for `task` lines (used for coloring). */
	status?: TaskStatus;
}

/**
 * Lines of the summary entry posted to the chat after the overlay is closed.
 *
 * - Expanded: headline, every task row, totals.
 * - Collapsed: headline, only tasks that need attention (failed, aborted),
 *   totals and a hint how many rows are hidden and how to expand.
 */
export function buildSummaryEntryLines(
	input: SummaryInput,
	expanded: boolean,
	expandKey = "ctrl+o",
): SummaryEntryLine[] {
	const visibleTasks = expanded ? input.tasks : input.tasks.filter((task) => taskNeedsAttention(task.status));
	const hidden = input.tasks.length - visibleTasks.length;

	const lines: SummaryEntryLine[] = [{ kind: "headline", text: buildSummaryHeadline(input) }];
	if (visibleTasks.length > 0) {
		lines.push({ kind: "blank", text: "" });
		for (const task of visibleTasks) {
			lines.push({ kind: "task", text: buildSummaryTaskLine(task), status: task.status });
		}
	}
	lines.push({ kind: "blank", text: "" });
	lines.push({ kind: "totals", text: buildSummaryTotalsLine(input) });
	if (hidden > 0) {
		lines.push({ kind: "hint", text: `${plural(hidden, "more task", "more tasks")} — ${expandKey} to expand` });
	}
	return lines;
}
