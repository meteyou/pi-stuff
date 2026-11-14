/**
 * PRD Loop Pro — Split a task into subtasks (pure, no pi imports).
 *
 * "Split task" in a pause menu: the prd-splitter subagent proposes subtasks
 * (see `SplitProposal` in ./subagent-result.ts); this module turns the
 * proposal into todo changes, following the rules of the `prd-to-todos`
 * skill ("Splitting an existing task into subtasks"):
 *
 * - Subtasks get hierarchical labels (`17/20` → `17a/20`, `17b/20`;
 *   `17a/20` → `17a1/20`, `17a2/20`); the total stays unchanged and labels
 *   are never reused.
 * - Subtasks without a dependency inside the split take over the parent's
 *   blockers; the others are blocked by the subtasks they depend on.
 * - The parent stays open as close-out task: it is blocked by the last
 *   subtasks (those no other subtask depends on) and its "What to build" /
 *   "Acceptance criteria" are reduced to what remains.
 * - Tasks blocked by the parent keep pointing at the parent.
 * - The PRD Task Index gets one row per subtask below the parent row.
 *
 * Everything is deterministic: ids, date and snapshot are passed in.
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import type { SplitProposal } from "./subagent-result.ts";
import { extractShortTitle, nextSubtaskLabels, titlePrefix } from "./task-sequence.ts";

/** Smallest / largest number of subtasks a split may have. */
export const SPLIT_MIN_SUBTASKS = 2;
export const SPLIT_MAX_SUBTASKS = 12;

const NO_BLOCKERS = "None — can start immediately";

// --- Markdown section helpers ---

function sectionRange(lines: string[], heading: string): { start: number; end: number } | undefined {
	const wanted = heading.trim().toLowerCase();
	const start = lines.findIndex((line) => line.trim().toLowerCase() === wanted);
	if (start === -1) return undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	return { start, end };
}

/** Content of a `## Heading` section (without the heading), or undefined. */
export function getSection(body: string, heading: string): string | undefined {
	const lines = body.split("\n");
	const range = sectionRange(lines, heading);
	if (!range) return undefined;
	return lines.slice(range.start + 1, range.end).join("\n").trim();
}

/** Replace the content of a `## Heading` section; the section is appended if missing. */
export function replaceSection(body: string, heading: string, content: string): string {
	const lines = body.trimEnd().split("\n");
	const range = sectionRange(lines, heading);
	const block = [heading, "", content.trim()];
	if (!range) {
		const base = body.trimEnd();
		return `${base ? `${base}\n\n` : ""}${block.join("\n")}`;
	}
	const before = lines.slice(0, range.start);
	const after = lines.slice(range.end);
	return [...before, ...block, ...(after.length > 0 ? ["", ...after] : [])].join("\n");
}

/** Append a line to a `## Heading` section; the section is appended if missing. */
export function appendToSection(body: string, heading: string, line: string): string {
	const existing = getSection(body, heading);
	return replaceSection(body, heading, existing ? `${existing}\n${line}` : line);
}

// --- Proposal validation ---

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Problems of a split proposal (empty = usable). */
export function validateSplitProposal(proposal: SplitProposal): string[] {
	const issues: string[] = [];
	const count = proposal.subtasks.length;
	if (count < SPLIT_MIN_SUBTASKS) issues.push(`a split needs at least ${SPLIT_MIN_SUBTASKS} subtasks, got ${count}`);
	if (count > SPLIT_MAX_SUBTASKS) issues.push(`a split may have at most ${SPLIT_MAX_SUBTASKS} subtasks, got ${count}`);
	proposal.subtasks.forEach((subtask, index) => {
		const number = index + 1;
		if (!oneLine(subtask.title)) issues.push(`subtask ${number} has no title`);
		if (!subtask.whatToBuild.trim()) issues.push(`subtask ${number} has no description`);
		if (subtask.acceptanceCriteria.filter((c) => c.trim()).length === 0) issues.push(`subtask ${number} has no acceptance criteria`);
		for (const dependency of subtask.dependsOn) {
			if (dependency < 1 || dependency >= number) {
				issues.push(`subtask ${number} depends on ${dependency}; only earlier subtasks (1…${number - 1}) are allowed`);
			}
		}
	});
	if (!proposal.parent.whatToBuild.trim()) issues.push("the remaining scope of the original task is not described");
	return issues;
}

// --- Split plan ---

export interface SplitParent {
	/** TODO-xxx id */
	id: string;
	title: string;
	body: string;
	sequenceLabel: string;
}

export interface SplitInput {
	parent: SplitParent;
	/** Sequence labels of all tasks of the PRD (to avoid reusing a label). */
	existingLabels: string[];
	proposal: SplitProposal;
	/** TODO-xxx ids for the new subtasks, one per subtask, in order. */
	newIds: string[];
	/** Date of the split, e.g. "2026-11-14". */
	date: string;
	/** Why the task is split (pause reason), one line. */
	reason: string;
	/** Snapshot of the changes of the failed attempt (git stash), if any. */
	snapshot?: { ref: string; message: string };
}

export interface PlannedSubtask {
	id: string;
	title: string;
	sequenceLabel: string;
	body: string;
	/** Ids of the subtasks of the split this one is blocked by. */
	blockedBy: string[];
}

export interface SplitPlan {
	subtasks: PlannedSubtask[];
	/** New body of the parent task (close-out task). */
	parentBody: string;
	/** Subtasks the parent is blocked by (no other subtask depends on them). */
	parentBlockedBy: string[];
}

const checklist = (criteria: string[]) =>
	criteria
		.map((c) => c.trim())
		.filter(Boolean)
		.map((c) => `- [ ] ${c.replace(/^- \[[ x]\]\s*/i, "")}`)
		.join("\n");

function earlierAttemptSection(snapshot: { ref: string; message: string }): string {
	return [
		`An earlier attempt on the unsplit task was saved as a git stash (\`${snapshot.ref}\`, "${snapshot.message}").`,
		"It is reference material, not a starting point: reuse what fits this subtask and leave the rest.",
		"",
		`- Overview: \`git stash show --include-untracked --stat ${snapshot.ref}\``,
		`- Full diff: \`git stash show --include-untracked -p ${snapshot.ref}\``,
		`- One file: \`git show ${snapshot.ref}:<path>\` (changed file) or \`git show ${snapshot.ref}^3:<path>\` (new file)`,
		"",
		"Do not apply the whole stash and do not drop it.",
	].join("\n");
}

/**
 * Build the todo changes of a split. Throws if the proposal is not usable or
 * the parent has no parsable sequence label.
 */
export function planSplit(input: SplitInput): SplitPlan {
	const { parent, proposal } = input;
	const issues = validateSplitProposal(proposal);
	if (issues.length > 0) throw new Error(`Invalid split proposal: ${issues.join("; ")}`);
	if (input.newIds.length !== proposal.subtasks.length) throw new Error("One todo id per subtask is required");

	const labels = nextSubtaskLabels(parent.sequenceLabel, input.existingLabels, proposal.subtasks.length);
	if (labels.length !== proposal.subtasks.length) {
		throw new Error(`Task "${parent.title}" has no sequence label (expected "Task M/T:"), cannot derive subtask labels`);
	}

	const prefix = titlePrefix(parent.title);
	const titles = proposal.subtasks.map((subtask, i) => `${prefix}Task ${labels[i]}: ${oneLine(subtask.title)}`);
	const ref = (index: number) => `- ${input.newIds[index]} (${titles[index]})`;
	const parentRef = `- ${parent.id} (${parent.title})`;

	const parentPrd = getSection(parent.body, "## Parent PRD");
	const userStories = getSection(parent.body, "## User stories addressed");
	const parentBlockers = getSection(parent.body, "## Blocked by")?.trim() || NO_BLOCKERS;
	const rationale = oneLine(proposal.rationale);
	const origin =
		`Split from ${parent.id} (${parent.title}) on ${input.date} by /prd-loop-pro: ${oneLine(input.reason)}.` +
		(rationale ? ` ${rationale}` : "");

	// Subtasks no other subtask depends on block the parent (close-out).
	const dependedOn = new Set(proposal.subtasks.flatMap((subtask) => subtask.dependsOn));
	const leaves = proposal.subtasks.map((_, i) => i).filter((i) => !dependedOn.has(i + 1));

	const subtasks: PlannedSubtask[] = proposal.subtasks.map((subtask, i) => {
		const dependencies = [...new Set(subtask.dependsOn)].sort((a, b) => a - b).map((n) => n - 1);
		const dependents = proposal.subtasks.map((other, j) => (other.dependsOn.includes(i + 1) ? j : -1)).filter((j) => j !== -1);
		const sections: string[] = [];
		sections.push("## Parent PRD", "", [parentPrd, origin].filter(Boolean).join("\n\n"), "");
		sections.push("## What to build", "", subtask.whatToBuild.trim(), "");
		sections.push("## Acceptance criteria", "", checklist(subtask.acceptanceCriteria), "");
		sections.push("## Blocked by", "", dependencies.length > 0 ? dependencies.map(ref).join("\n") : parentBlockers, "");
		sections.push("## Next task", "", dependents.length > 0 ? dependents.map(ref).join("\n") : parentRef);
		if (userStories) sections.push("", "## User stories addressed", "", userStories);
		if (input.snapshot) sections.push("", "## Earlier attempt", "", earlierAttemptSection(input.snapshot));
		return {
			id: input.newIds[i]!,
			title: titles[i]!,
			sequenceLabel: labels[i]!,
			body: sections.join("\n"),
			blockedBy: dependencies.map((d) => input.newIds[d]!),
		};
	});

	const first = labels[0]!.split("/")[0];
	const last = labels.at(-1)!.split("/")[0];
	let parentBody = parent.body;
	parentBody = replaceSection(
		parentBody,
		"## What to build",
		`${proposal.parent.whatToBuild.trim()}\n\n` +
			`This is the close-out of a split: the work was moved to the subtasks ${first}–${last} ` +
			`(${input.newIds.join(", ")}), which are done first.`,
	);
	const parentCriteria = checklist(proposal.parent.acceptanceCriteria);
	if (parentCriteria) parentBody = replaceSection(parentBody, "## Acceptance criteria", parentCriteria);
	parentBody = replaceSection(parentBody, "## Blocked by", leaves.map(ref).join("\n"));
	parentBody = appendToSection(
		parentBody,
		"## History",
		`- ${input.date}: split into ${first}–${last} by /prd-loop-pro (${oneLine(input.reason)}).` +
			(rationale ? ` ${rationale}` : "") +
			(input.snapshot ? ` Changes of the attempt: git stash \`${input.snapshot.ref}\`.` : ""),
	);

	return { subtasks, parentBody, parentBlockedBy: leaves.map((i) => input.newIds[i]!) };
}

// --- PRD Task Index ---

type IndexColumn = "number" | "task" | "todo" | "blockedBy" | "status" | "other";

const DEFAULT_COLUMNS: IndexColumn[] = ["number", "task", "todo", "blockedBy", "status"];

function classifyHeaderCell(cell: string): IndexColumn {
	const text = cell.trim().toLowerCase();
	if (text === "#" || text === "nr" || text === "no" || text === "no.") return "number";
	if (text === "task" || text === "title") return "task";
	if (text === "todo" || text === "id") return "todo";
	if (text.startsWith("blocked")) return "blockedBy";
	if (text === "status") return "status";
	return "other";
}

const isTableRow = (line: string) => (line.match(/\|/g) || []).length >= 4;
const rowCells = (line: string) => line.split("|").slice(1, -1);

/**
 * Add one PRD Task Index row per subtask directly below the parent's row and
 * set the parent's "Blocked by" cell. Returns the body unchanged (and
 * `updated: false`) if the parent has no row in the index.
 */
export function addSplitToPrdIndex(
	prdBody: string,
	parentId: string,
	plan: SplitPlan,
): { body: string; updated: boolean } {
	const lines = prdBody.split("\n");
	const parentRow = lines.findIndex((line) => isTableRow(line) && line.match(/TODO-[0-9a-f]+/i)?.[0] === parentId);
	if (parentRow === -1) return { body: prdBody, updated: false };

	// Column layout from the header row of the table (the row above the |---| separator).
	let columns = DEFAULT_COLUMNS;
	for (let i = parentRow - 1; i >= 0 && isTableRow(lines[i]!); i--) {
		if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]!) && i > 0 && isTableRow(lines[i - 1]!)) {
			const header = rowCells(lines[i - 1]!).map(classifyHeaderCell);
			if (header.includes("todo")) columns = header;
			break;
		}
	}

	const cell = (text: string) => ` ${text.replace(/\|/g, "/")} `;
	const newRows = plan.subtasks.map((subtask) => {
		const cells = columns.map((column) => {
			switch (column) {
				case "number": return cell(subtask.sequenceLabel);
				case "task": return cell(extractShortTitle(subtask.title));
				case "todo": return cell(subtask.id);
				case "blockedBy": return cell(subtask.blockedBy.length > 0 ? subtask.blockedBy.join(", ") : "—");
				case "status": return cell("⏳ blocked");
				default: return " ";
			}
		});
		return `|${cells.join("|")}|`;
	});

	const blockedByColumn = columns.indexOf("blockedBy");
	const parentCells = lines[parentRow]!.split("|");
	if (blockedByColumn !== -1 && blockedByColumn + 1 < parentCells.length - 1) {
		parentCells[blockedByColumn + 1] = cell(plan.parentBlockedBy.join(", "));
		lines[parentRow] = parentCells.join("|");
	}

	lines.splice(parentRow + 1, 0, ...newRows);
	return { body: lines.join("\n"), updated: true };
}

// --- Confirmation dialog ---

/** Lines describing a split proposal for the confirmation dialog. */
export function describeSplitProposal(proposal: SplitProposal, labels: string[]): string[] {
	const lines: string[] = [];
	const rationale = oneLine(proposal.rationale);
	if (rationale) lines.push(rationale, "");
	proposal.subtasks.forEach((subtask, i) => {
		const label = labels[i]?.split("/")[0] ?? String(i + 1);
		const dependencies = subtask.dependsOn.map((n) => labels[n - 1]?.split("/")[0] ?? String(n));
		const after = dependencies.length > 0 ? ` (after ${dependencies.join(", ")})` : "";
		const criteria = subtask.acceptanceCriteria.filter((c) => c.trim()).length;
		lines.push(`  ${label}: ${oneLine(subtask.title)}${after} — ${criteria} acceptance criteri${criteria === 1 ? "on" : "a"}`);
	});
	lines.push("", `  Close-out (original task): ${oneLine(proposal.parent.whatToBuild)}`);
	return lines;
}
