/**
 * PRD Loop Pro — Execution report (pure, no pi imports).
 *
 * Builds the deterministic `## Execution Report` markdown section that is
 * appended to a task todo after a pipeline run, plus the "open findings"
 * section used when a task is released to a human (`needs-human`).
 *
 * The output depends only on the given run record (no clock, no randomness),
 * so identical records produce identical markdown.
 *
 * Intentionally free of pi imports so it can be unit-tested with `node --test`
 * (native TypeScript type stripping). Only erasable TypeScript syntax is used.
 */

import type { ReviewFinding } from "./subagent-result.ts";

/** Pipeline phases that can incur cost. */
export type CostPhase = "implement" | "review" | "fix" | "commit" | "repair";

export const COST_PHASES: readonly CostPhase[] = ["implement", "review", "fix", "commit", "repair"];

export const COST_PHASE_LABELS: Record<CostPhase, string> = {
	implement: "implement",
	review: "review",
	fix: "fix",
	commit: "commit",
	repair: "JSON repair",
};

export interface FixedFinding {
	finding: ReviewFinding;
	/** Fixer summary (what was changed). */
	summary?: string;
	/** Review round in which the finding was raised (1-based). */
	round?: number;
}

export interface RejectedFinding {
	finding: ReviewFinding;
	/** Fixer's reason for rejecting the finding. */
	reason: string;
	round?: number;
}

export interface UnresolvedFinding {
	finding: ReviewFinding;
	/** Why the finding is still open (e.g. fixer crashed, round limit, not fixed). */
	reason?: string;
	round?: number;
}

export interface CommitRef {
	sha: string;
	subject?: string;
}

/** Everything the report needs to know about one task run. */
export interface ExecutionRecord {
	/** Summary returned by the implementer (prd-worker). */
	implementerSummary: string;
	/** Number of completed review rounds (0 = no review ran). */
	reviewRounds: number;
	/** Verdict of the last review round, if any. */
	finalVerdict?: "correct" | "needs attention";
	/** Summary of the last review round, if any. */
	reviewSummary?: string;
	/** Optional note about the review (e.g. why it was skipped). */
	reviewNote?: string;
	fixed: FixedFinding[];
	rejected: RejectedFinding[];
	/** Findings below the fix threshold (not fixed by design). */
	deferred: ReviewFinding[];
	/** Findings at/above the threshold that are still open. */
	unresolved: UnresolvedFinding[];
	/** Human reviewer callouts (deduplicated by the report). */
	callouts: string[];
	/** Commits created for this task (determined by the orchestrator). */
	commits: CommitRef[];
	/** Cost in USD per phase; missing phases count as 0. */
	cost: Partial<Record<CostPhase, number>>;
}

export const EXECUTION_REPORT_HEADING = "## Execution Report";
export const OPEN_FINDINGS_HEADING = "## Open Findings";

const NONE = "_None._";

/** Format a USD amount with 2 decimals (4 for small non-zero amounts). */
export function formatCost(amount: number): string {
	const value = Number.isFinite(amount) ? amount : 0;
	if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

/** Collapse whitespace into a single line (for list item titles). */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** `file:line`, `file` or empty string. */
export function formatLocation(finding: Pick<ReviewFinding, "file" | "line">): string {
	const file = finding.file.trim();
	if (!file) return "";
	return finding.line !== undefined && finding.line > 0 ? `${file}:${finding.line}` : file;
}

/** One-line finding headline: `**[P1]** Title — `file:line``. */
export function formatFindingHeadline(finding: ReviewFinding): string {
	const location = formatLocation(finding);
	const title = oneLine(finding.title) || "(untitled)";
	return `**[${finding.priority}]** ${title}${location ? ` — \`${location}\`` : ""}`;
}

interface FindingDetail {
	label?: string;
	text: string;
}

/** Nested bullet (`  - `) whose continuation lines are indented to stay inside the item. */
function nestedBullet(text: string): string {
	const [first, ...rest] = text.trim().split("\n");
	const lines = [`  - ${first!.trimEnd()}`];
	for (const line of rest) lines.push(line.trim() ? `    ${line.trimEnd()}` : "");
	return lines.join("\n");
}

/**
 * Finding as a list item: headline, then the explanation (optional) and the
 * labelled details as nested bullets.
 */
function formatFindingItem(finding: ReviewFinding, details: FindingDetail[], includeBody: boolean): string {
	const lines = [`- ${formatFindingHeadline(finding)}`];
	if (includeBody && finding.body.trim()) {
		lines.push(nestedBullet(finding.body));
	}
	for (const detail of details) {
		if (!detail.text.trim()) continue;
		const label = detail.label ? `*${detail.label}:* ` : "";
		lines.push(nestedBullet(`${label}${detail.text.trim()}`));
	}
	return lines.join("\n");
}

function roundDetail(round: number | undefined): FindingDetail[] {
	return round !== undefined ? [{ label: "Round", text: String(round) }] : [];
}

/** Stable sort by priority (P0 first); input order is kept within a priority. */
export function sortByPriority<T>(items: T[], getFinding: (item: T) => ReviewFinding): T[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const diff = getFinding(a.item).priority.localeCompare(getFinding(b.item).priority);
			return diff !== 0 ? diff : a.index - b.index;
		})
		.map(({ item }) => item);
}

function section(title: string, items: string[]): string {
	return [`### ${title}`, "", items.length > 0 ? items.join("\n") : NONE].join("\n");
}

/** Deduplicate (trimmed, case-sensitive) while keeping order; drops empty entries. */
function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = oneLine(value);
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/** Total cost over all phases. */
export function totalCost(cost: Partial<Record<CostPhase, number>>): number {
	return COST_PHASES.reduce((sum, phase) => sum + (cost[phase] ?? 0), 0);
}

function formatCostLine(cost: Partial<Record<CostPhase, number>>): string {
	const parts = COST_PHASES
		.filter((phase) => (cost[phase] ?? 0) > 0)
		.map((phase) => `${COST_PHASE_LABELS[phase]} ${formatCost(cost[phase]!)}`);
	const total = formatCost(totalCost(cost));
	return parts.length > 0 ? `${total} (${parts.join(", ")})` : total;
}

function formatCommit(commit: CommitRef): string {
	const subject = commit.subject ? oneLine(commit.subject) : "";
	return `- \`${commit.sha}\`${subject ? ` ${subject}` : ""}`;
}

function formatReviewLine(record: ExecutionRecord): string {
	const rounds = `${record.reviewRounds} round${record.reviewRounds === 1 ? "" : "s"}`;
	const parts = [rounds];
	if (record.finalVerdict) parts.push(`final verdict: ${record.finalVerdict}`);
	return parts.join(", ");
}

/**
 * Build the `## Execution Report` markdown section for a task todo.
 *
 * Sections: implementer summary, review (rounds, verdict, summary), fixed,
 * rejected (with reasons), deferred, unresolved, human reviewer callouts,
 * commits and cost. Empty lists are rendered as `_None._`.
 */
export function buildExecutionReport(record: ExecutionRecord): string {
	const out: string[] = [EXECUTION_REPORT_HEADING, ""];

	out.push(`- **Review:** ${formatReviewLine(record)}`);
	out.push(
		`- **Findings:** ${record.fixed.length} fixed, ${record.rejected.length} rejected, ` +
			`${record.deferred.length} deferred, ${record.unresolved.length} unresolved`,
	);
	out.push(`- **Commits:** ${record.commits.length}`);
	out.push(`- **Cost:** ${formatCostLine(record.cost)}`);
	out.push("");

	out.push("### Implementer summary", "", record.implementerSummary.trim() || NONE, "");

	const reviewLines: string[] = [];
	if (record.reviewNote?.trim()) reviewLines.push(`_${oneLine(record.reviewNote)}_`);
	if (record.reviewSummary?.trim()) reviewLines.push(record.reviewSummary.trim());
	if (reviewLines.length > 0) {
		out.push("### Review summary", "", reviewLines.join("\n\n"), "");
	}

	out.push(
		section(
			"Fixed findings",
			sortByPriority(record.fixed, (item) => item.finding).map((item) =>
				formatFindingItem(item.finding, [...roundDetail(item.round), { label: "Fix", text: item.summary ?? "" }], false),
			),
		),
		"",
	);
	out.push(
		section(
			"Rejected findings",
			sortByPriority(record.rejected, (item) => item.finding).map((item) =>
				formatFindingItem(item.finding, [...roundDetail(item.round), { label: "Reason", text: item.reason || "(no reason given)" }], true),
			),
		),
		"",
	);
	out.push(section("Deferred findings (below fix threshold)", sortByPriority(record.deferred, (finding) => finding).map((finding) => formatFindingItem(finding, [], true))), "");
	out.push(
		section(
			"Unresolved findings",
			sortByPriority(record.unresolved, (item) => item.finding).map((item) =>
				formatFindingItem(item.finding, [...roundDetail(item.round), { label: "Status", text: item.reason ?? "" }], true),
			),
		),
		"",
	);
	out.push(section("Human reviewer callouts", dedupe(record.callouts).map((callout) => `- ${callout}`)), "");
	out.push(section("Commits", record.commits.map(formatCommit)));

	return out.join("\n");
}

/** Context of a release to a human (shown at the top of the open findings section). */
export interface ReleaseInfo {
	/** Why the task was released (e.g. "review round limit reached (3/3)", "git hook failed"). */
	reason?: string;
	/** Errors of the failed phase (e.g. committer / hook output). */
	errors?: string[];
}

/**
 * Build the "open findings" section appended to a task todo when it is
 * released to a human (`needs-human`). Lists every open finding with its
 * explanation; rejected findings are listed separately with their reasons.
 * Optionally states why the task was released and the errors of the failed
 * phase.
 */
export function buildOpenFindingsSection(
	open: UnresolvedFinding[],
	rejected: RejectedFinding[] = [],
	release: ReleaseInfo = {},
): string {
	const out: string[] = [OPEN_FINDINGS_HEADING, ""];
	if (release.reason?.trim()) {
		out.push(`- **Released to a human:** ${oneLine(release.reason)}`);
		out.push("- **Next step:** fix manually (or with the main agent), then re-run `/prd-loop-pro` to commit & close the task, close it if already committed, or review again.");
		out.push("");
	}
	out.push(
		open.length > 0
			? "The automated review-fix cycle stopped with the following findings still open. Resolve them manually, then re-run the loop to close the task."
			: "The automated review-fix cycle stopped without open findings.",
		"",
	);
	const errors = (release.errors ?? []).filter((error) => error.trim());
	if (errors.length > 0) {
		out.push(section("Errors", errors.map((error) => formatFindingErrorItem(error))), "");
	}
	out.push(
		section(
			"Open",
			sortByPriority(open, (item) => item.finding).map((item) => formatFindingItem(item.finding, [...roundDetail(item.round), { label: "Status", text: item.reason ?? "" }], true)),
		),
	);
	if (rejected.length > 0) {
		out.push(
			"",
			section(
				"Rejected by fixer",
				sortByPriority(rejected, (item) => item.finding).map((item) =>
					formatFindingItem(item.finding, [...roundDetail(item.round), { label: "Reason", text: item.reason || "(no reason given)" }], true),
				),
			),
		);
	}
	return out.join("\n");
}

/** Error as a list item; multi-line errors keep their continuation lines inside the item. */
function formatFindingErrorItem(error: string): string {
	const [first, ...rest] = error.trim().split("\n");
	const lines = [`- ${first!.trimEnd()}`];
	for (const line of rest) lines.push(line.trim() ? `  ${line.trimEnd()}` : "");
	return lines.join("\n");
}

/**
 * Append a markdown section to a todo body, separated by a blank line.
 * Trailing whitespace of the body is normalized.
 */
export function appendSection(body: string, sectionMarkdown: string): string {
	const trimmedBody = body.trimEnd();
	const trimmedSection = sectionMarkdown.trim();
	if (!trimmedBody) return trimmedSection;
	return `${trimmedBody}\n\n${trimmedSection}`;
}
