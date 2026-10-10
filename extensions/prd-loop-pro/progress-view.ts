/**
 * PRD Loop Pro — Phase-aware progress view model (pure, no pi imports).
 *
 * Everything the overlay, the output viewer and the final summary widget
 * display about the multi-phase pipeline, as plain data and plain strings
 * (theming and width truncation happen in ./index.ts):
 *
 * - Output log grouped by phase: one group per subagent run with a header
 *   (`Implement`, `Review #1`, `Fix #1 • 3 findings`, `Commit`), its
 *   activity events, cost and a one-line outcome.
 * - Task details: review round counter, fixed/rejected/deferred/unresolved
 *   counts and cost per phase.
 * - Final summary: per task status, time, cost, retries, review rounds and
 *   finding counts; tasks released to a human (`needs-human`) are marked ⚠️.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import type { FindingPriority } from "./subagent-result.ts";
import type { CostPhase } from "./execution-report.ts";
import type { FixOutcome } from "./review-cycle.ts";
import { PRIORITY_ORDER } from "./review-cycle.ts";
import { COST_PHASE_LABELS, COST_PHASES, formatCost, totalCost } from "./execution-report.ts";

// --- Subagent activity & output events ---

/** Activity update from a running subagent. */
export interface SubagentActivity {
	/** Type of activity */
	type: "tool_start" | "tool_end" | "text_delta" | "thinking";
	/** Tool name (for tool_start/tool_end) */
	toolName?: string;
	/** Tool arguments summary (for tool_start) */
	argsSummary?: string;
	/** Whether tool succeeded (for tool_end) */
	toolSuccess?: boolean;
	/** Text snippet (for text_delta) */
	text?: string;
	/** Current turn number */
	turn: number;
	/** Preview of tool result (for tool_end) */
	resultPreview?: string;
}

/** Structured event from a running subagent, stored for the output viewer. */
export interface OutputEvent {
	time: number;
	kind: "tool_start" | "tool_end" | "text" | "thinking";
	tool?: string;
	args?: string;
	result?: string;
	error?: boolean;
	text?: string;
	turn: number;
}

/**
 * Append a subagent activity to an output event list. Consecutive text/thinking
 * deltas are collapsed into a single event.
 */
export function appendOutputEvent(events: OutputEvent[], activity: SubagentActivity, now: number = Date.now()): void {
	switch (activity.type) {
		case "tool_start":
			events.push({ time: now, kind: "tool_start", tool: activity.toolName, args: activity.argsSummary, turn: activity.turn });
			break;
		case "tool_end":
			events.push({
				time: now,
				kind: "tool_end",
				tool: activity.toolName,
				error: !activity.toolSuccess,
				result: activity.resultPreview,
				turn: activity.turn,
			});
			break;
		case "text_delta":
			if (events.at(-1)?.kind !== "text") events.push({ time: now, kind: "text", turn: activity.turn });
			break;
		case "thinking":
			if (events.at(-1)?.kind !== "thinking") events.push({ time: now, kind: "thinking", turn: activity.turn });
			break;
	}
}

// --- Phase-grouped output ---

/** Identifies one subagent run within the pipeline of a task. */
export type PhaseRef =
	| { phase: "implement"; attempt?: number }
	| { phase: "review"; round: number }
	| { phase: "fix"; round: number; count: number }
	| { phase: "commit" };

/** Output of one subagent run, shown under its own header in the output viewer. */
export interface PhaseOutputGroup {
	phase: PhaseRef["phase"];
	/** Header text, e.g. `Review #2` or `Fix #1 • 3 findings`. */
	header: string;
	startTime: number;
	endTime?: number;
	events: OutputEvent[];
	/** Cost of this run (incl. JSON repair), once known. */
	cost?: number;
	/** One-line outcome (e.g. `2 fixed, 1 rejected`, `needs attention • 3 findings`). */
	outcome?: string;
	/** True if the outcome is a failure (crash, invalid result, pause). */
	failed?: boolean;
}

/** Collapse whitespace into a single line. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Header of a phase group: `Implement`, `Implement (attempt 2)`, `Review #1`,
 * `Fix #1 • 3 findings`, `Commit`. An optional note is appended in
 * parentheses (e.g. `resumed`, `retry`), combined with the attempt:
 * `Implement (attempt 2, resumed)`.
 */
export function phaseHeader(ref: PhaseRef, note?: string): string {
	let header: string;
	const qualifiers: string[] = [];
	switch (ref.phase) {
		case "implement":
			header = "Implement";
			if (ref.attempt !== undefined && ref.attempt > 1) qualifiers.push(`attempt ${ref.attempt}`);
			break;
		case "review":
			header = `Review #${ref.round}`;
			break;
		case "fix":
			header = fixPhaseLabel(ref.round, ref.count);
			break;
		case "commit":
			header = "Commit";
			break;
	}
	const trimmedNote = note ? oneLine(note) : "";
	if (trimmedNote) qualifiers.push(trimmedNote);
	return qualifiers.length > 0 ? `${header} (${qualifiers.join(", ")})` : header;
}

/** Start a new phase group (closes the previous one) and return it. */
export function startPhaseGroup(
	groups: PhaseOutputGroup[],
	ref: PhaseRef,
	options: { note?: string; now?: number } = {},
): PhaseOutputGroup {
	const now = options.now ?? Date.now();
	const previous = groups.at(-1);
	if (previous && previous.endTime === undefined) previous.endTime = now;
	const group: PhaseOutputGroup = { phase: ref.phase, header: phaseHeader(ref, options.note), startTime: now, events: [] };
	groups.push(group);
	return group;
}

/** Record the result of the latest group (cost, outcome) and close it. */
export function finishPhaseGroup(
	groups: PhaseOutputGroup[],
	result: { cost?: number; outcome?: string; failed?: boolean },
	now: number = Date.now(),
): void {
	const group = groups.at(-1);
	if (!group) return;
	if (result.cost !== undefined) group.cost = (group.cost ?? 0) + result.cost;
	if (result.outcome !== undefined) group.outcome = oneLine(result.outcome);
	if (result.failed !== undefined) group.failed = result.failed;
	if (group.endTime === undefined) group.endTime = now;
}

/**
 * Append a subagent activity to the latest phase group. Activity without a
 * group (should not happen) goes into a generic `Output` group.
 */
export function appendPhaseEvent(groups: PhaseOutputGroup[], activity: SubagentActivity, now: number = Date.now()): void {
	let group = groups.at(-1);
	if (!group) {
		group = { phase: "implement", header: "Output", startTime: now, events: [] };
		groups.push(group);
	}
	appendOutputEvent(group.events, activity, now);
}

/** Total number of events across all groups. */
export function countPhaseEvents(groups: readonly PhaseOutputGroup[]): number {
	return groups.reduce((sum, group) => sum + group.events.length, 0);
}

/** Review outcome for a group header: `needs attention • 3 findings (1×P1, 2×P3)` / `correct • no findings`. */
export function formatReviewOutcome(verdict: string, findings: readonly { priority: FindingPriority }[]): string {
	if (findings.length === 0) return `${verdict} • no findings`;
	const byPriority = PRIORITY_ORDER
		.map((priority) => ({ priority, count: findings.filter((f) => f.priority === priority).length }))
		.filter((entry) => entry.count > 0)
		.map((entry) => `${entry.count}×${entry.priority}`);
	return `${verdict} • ${findings.length} finding${findings.length === 1 ? "" : "s"} (${byPriority.join(", ")})`;
}

/** Label of a fix batch (group header and phase label): `Fix #1 • 3 findings`. */
export function fixPhaseLabel(round: number, count: number): string {
	return `Fix #${round} • ${count} finding${count === 1 ? "" : "s"}`;
}

/** Batch fixer outcome for a group header: `2 fixed, 1 rejected, 1 unresolved` (zero counts omitted). */
export function formatFixOutcomes(outcomes: readonly FixOutcome[]): string {
	const count = (status: FixOutcome["status"]) => outcomes.filter((outcome) => outcome.status === status).length;
	const parts = (["fixed", "rejected", "unresolved"] as const)
		.map((status) => ({ status, n: count(status) }))
		.filter((entry) => entry.n > 0)
		.map((entry) => `${entry.n} ${entry.status}`);
	return parts.length > 0 ? parts.join(", ") : "no findings";
}

/** Format elapsed milliseconds as "M:SS". */
export function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Meta text shown after a group header: outcome, cost and duration
 * (`running…` for the open group).
 */
export function phaseGroupMeta(group: PhaseOutputGroup, now: number = Date.now()): string {
	const parts: string[] = [];
	if (group.outcome) parts.push(group.outcome);
	else if (group.endTime === undefined) parts.push("running…");
	if (group.cost !== undefined && group.cost > 0) parts.push(formatCost(group.cost));
	parts.push(formatElapsed((group.endTime ?? now) - group.startTime));
	return parts.join(" • ");
}

// --- Task status ---

/** `needs-human` = released to a human (todo status `needs-human`), resolved at the next start. */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "retrying" | "aborted" | "needs-human";

/** Status icon for a task. */
export function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "pending": return "⏳";
		case "running": return "🔄";
		case "completed": return "✅";
		case "failed": return "❌";
		case "retrying": return "🔁";
		case "aborted": return "⚠️";
		case "needs-human": return "🔧";
	}
}

/** Marker for tasks that need attention by a human in the final summary. */
export const NEEDS_HUMAN_MARKER = "⚠️";

// --- Task details ---

/** Review-fix cycle progress of a task (for details and summary). */
export interface TaskReviewProgress {
	/** Completed review rounds. */
	round: number;
	/** Current round limit (raised by "One more round"). */
	roundLimit: number;
	fixed: number;
	rejected: number;
	deferred: number;
	unresolved: number;
	/** Verdict of the last completed round. */
	verdict?: string;
	callouts?: number;
}

/** `2 fixed • 1 rejected • 3 deferred • 0 unresolved` */
export function formatFindingCounts(counts: Pick<TaskReviewProgress, "fixed" | "rejected" | "deferred" | "unresolved">, separator = " • "): string {
	return [
		`${counts.fixed} fixed`,
		`${counts.rejected} rejected`,
		`${counts.deferred} deferred`,
		`${counts.unresolved} unresolved`,
	].join(separator);
}

/** `$0.45 — implement $0.20 • review $0.15 • fix $0.10` (phases without cost are omitted). */
export function formatPhaseCosts(cost: Partial<Record<CostPhase, number>>): string {
	const total = formatCost(totalCost(cost));
	const parts = COST_PHASES
		.filter((phase) => (cost[phase] ?? 0) > 0)
		.map((phase) => `${COST_PHASE_LABELS[phase]} ${formatCost(cost[phase]!)}`);
	return parts.length > 0 ? `${total} — ${parts.join(" • ")}` : total;
}

/** One labelled line of the task details (`Rounds: 2/3 • needs attention`). */
export interface TaskDetailLine {
	label: string;
	text: string;
}

/**
 * Review/cost detail lines of a task: round counter (+ last verdict and
 * callouts), finding counts, an optional review note (e.g. review skipped)
 * and the cost per phase.
 */
export function buildTaskDetailLines(input: {
	review?: TaskReviewProgress;
	reviewNote?: string;
	phaseCosts?: Partial<Record<CostPhase, number>>;
}): TaskDetailLine[] {
	const lines: TaskDetailLine[] = [];
	const review = input.review;
	if (review) {
		const parts = [`${review.round}/${review.roundLimit}`];
		if (review.verdict) parts.push(review.verdict);
		const callouts = review.callouts ?? 0;
		if (callouts > 0) parts.push(`${callouts} callout${callouts === 1 ? "" : "s"}`);
		lines.push({ label: "Rounds", text: parts.join(" • ") });
		lines.push({ label: "Findings", text: formatFindingCounts(review) });
	}
	if (input.reviewNote?.trim()) lines.push({ label: "Review", text: oneLine(input.reviewNote) });
	if (input.phaseCosts && totalCost(input.phaseCosts) > 0) {
		lines.push({ label: "Cost", text: formatPhaseCosts(input.phaseCosts) });
	}
	return lines;
}

// --- Final summary ---

export interface SummaryTask {
	/** `Task 3/11: Short title` */
	label: string;
	status: TaskStatus;
	/** Time spent on the task in this run (if it ran). */
	elapsedMs?: number;
	cost: number;
	retries: number;
	/** Review-fix progress (if a review ran in this run). */
	review?: TaskReviewProgress;
	/** Why the review didn't run (e.g. `review skipped`), shown if no review progress exists. */
	reviewNote?: string;
}

export type SummaryOutcome = "completed" | "failed" | "aborted" | "released";

export interface SummaryInput {
	prdTitle: string;
	outcome: SummaryOutcome;
	tasks: SummaryTask[];
	totalElapsedMs: number;
	totalCost: number;
	totalCommits: number;
}

const OUTCOME_ICONS: Record<SummaryOutcome, string> = { completed: "✅", failed: "❌", aborted: "⚠️", released: "🔧" };
const OUTCOME_TEXTS: Record<SummaryOutcome, string> = {
	completed: "Loop completed",
	failed: "Loop failed",
	aborted: "Loop aborted",
	released: "Loop stopped — task released to a human (needs-human)",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Review part of a summary row: `2 rounds: 2 fixed, 1 rejected, 3 deferred, 0 unresolved`. */
function summaryReviewPart(review: TaskReviewProgress): string {
	return `${plural(review.round, "round")}: ${formatFindingCounts(review, ", ")}`;
}

/** One summary row per task. `needs-human` tasks are prefixed with ⚠️ and tagged. */
export function buildSummaryTaskLine(task: SummaryTask): string {
	const needsHuman = task.status === "needs-human";
	const parts = [`${needsHuman ? `${NEEDS_HUMAN_MARKER} ` : ""}${task.label}  ${statusIcon(task.status)}`];
	if (task.elapsedMs !== undefined) parts.push(formatElapsed(task.elapsedMs));
	if (task.cost > 0) parts.push(formatCost(task.cost));
	if (task.retries > 0) parts.push(plural(task.retries, "retry", "retries"));
	if (task.review) parts.push(summaryReviewPart(task.review));
	else if (task.reviewNote?.trim()) parts.push(oneLine(task.reviewNote));
	if (needsHuman) parts.push(`${NEEDS_HUMAN_MARKER} needs-human`);
	return parts.join("  ");
}

/** Summary headline: `✅ <PRD title> — Loop completed`. */
export function buildSummaryHeadline(input: Pick<SummaryInput, "prdTitle" | "outcome">): string {
	return `${OUTCOME_ICONS[input.outcome]} ${input.prdTitle} — ${OUTCOME_TEXTS[input.outcome]}`;
}

/** Outcome text without the PRD title: `✅ Loop completed`. */
export function buildOutcomeLabel(outcome: SummaryOutcome): string {
	return `${OUTCOME_ICONS[outcome]} ${OUTCOME_TEXTS[outcome]}`;
}

/**
 * Final summary lines: outcome headline, one row per task, totals
 * (time, cost, retries, commits, review rounds, finding counts and the
 * number of tasks that need a human).
 */
export function buildSummaryLines(input: SummaryInput): string[] {
	const lines: string[] = [];
	lines.push(buildSummaryHeadline(input));
	lines.push("");

	for (const task of input.tasks) lines.push(buildSummaryTaskLine(task));
	lines.push("");
	lines.push(buildSummaryTotalsLine(input));

	return lines;
}

/** Totals row of the summary (time, cost, retries, commits, review totals, needs-human count). */
export function buildSummaryTotalsLine(input: SummaryInput): string {
	const totalRetries = input.tasks.reduce((sum, t) => sum + t.retries, 0);
	const reviewed = input.tasks.filter((t) => t.review).map((t) => t.review!);
	const totals = [
		`Total: ${formatElapsed(input.totalElapsedMs)}`,
		formatCost(input.totalCost),
		plural(totalRetries, "retry", "retries"),
		plural(input.totalCommits, "commit"),
	];
	if (reviewed.length > 0) {
		const sum = (key: "round" | "fixed" | "rejected" | "deferred" | "unresolved") =>
			reviewed.reduce((acc, review) => acc + review[key], 0);
		totals.push(plural(sum("round"), "review round"));
		totals.push(formatFindingCounts({ fixed: sum("fixed"), rejected: sum("rejected"), deferred: sum("deferred"), unresolved: sum("unresolved") }, ", "));
	}
	const needsHuman = input.tasks.filter((t) => t.status === "needs-human").length;
	if (needsHuman > 0) totals.push(`${NEEDS_HUMAN_MARKER} ${needsHuman} needs-human`);
	return totals.join(" | ");
}

/** Tasks that still need attention after a run; they stay visible in the collapsed summary entry. */
export function taskNeedsAttention(status: TaskStatus): boolean {
	return status === "needs-human" || status === "failed" || status === "aborted";
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
 * - Collapsed: headline, only tasks that need attention (needs-human, failed,
 *   aborted), totals and a hint how many rows are hidden and how to expand.
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
