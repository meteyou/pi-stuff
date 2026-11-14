/**
 * PRD Loop Pro — Hand-over to the main session (pure, no pi imports).
 *
 * "Release / hand over" in a pause menu stops the loop with the task marked
 * `needs-human`. So that the main agent does not have to reconstruct what
 * happened, the loop puts a prepared prompt into the editor after the overlay
 * is closed: task, PRD, phase, reason, errors, the implementer's summary and
 * split proposal, and the subagent log files. The prompt is not sent
 * automatically; the human can edit or discard it.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import type { ProposedPart } from "./subagent-result.ts";

/** Maximum number of errors / length of one text in the prompt. */
export const HANDOVER_MAX_ERRORS = 8;
export const HANDOVER_MAX_TEXT_LENGTH = 1500;

export interface HandoverInfo {
	/** TODO-xxx id of the task */
	taskId: string;
	taskTitle: string;
	/** TODO-xxx id of the PRD */
	prdId: string;
	prdTitle: string;
	/** Phase label incl. progress, e.g. "Implement" or "Review 2/3". */
	phase: string;
	reason: string;
	errors?: string[];
	/** Summary of the last subagent result. */
	summary?: string;
	/** Parts proposed by the implementer when it reported the task as blocked. */
	proposedSplit?: ProposedPart[];
	/** Number of open review findings appended to the todo. */
	openFindings?: number;
	logFiles?: string[];
}

function clip(text: string): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= HANDOVER_MAX_TEXT_LENGTH ? clean : `${clean.slice(0, HANDOVER_MAX_TEXT_LENGTH - 1)}…`;
}

/** Prompt for the main session after a task was released / handed over. */
export function buildHandoverPrompt(info: HandoverInfo): string {
	const lines = [
		"The PRD loop (/prd-loop-pro) stopped at a task and handed it over to this session.",
		"",
		`- Task: ${info.taskId} "${info.taskTitle}" (status: needs-human)`,
		`- PRD: ${info.prdId} "${info.prdTitle}"`,
		`- Phase: ${info.phase}`,
		`- Reason: ${clip(info.reason)}`,
	];

	const errors = (info.errors ?? []).filter((error) => error.trim());
	if (errors.length > 0) {
		lines.push("- Errors:");
		for (const error of errors.slice(0, HANDOVER_MAX_ERRORS)) lines.push(`  - ${clip(error)}`);
		if (errors.length > HANDOVER_MAX_ERRORS) lines.push(`  - … and ${errors.length - HANDOVER_MAX_ERRORS} more (see the todo)`);
	}
	if (info.summary?.trim()) lines.push(`- Last subagent summary: ${clip(info.summary)}`);
	const parts = (info.proposedSplit ?? []).filter((part) => part.title.trim());
	if (parts.length > 0) {
		lines.push("- Split proposed by the implementer:");
		parts.forEach((part, i) => {
			const description = part.description.trim() ? ` — ${clip(part.description)}` : "";
			lines.push(`  ${i + 1}. ${clip(part.title)}${description}`);
		});
	}
	if (info.openFindings && info.openFindings > 0) {
		lines.push(`- ${info.openFindings} open review finding${info.openFindings === 1 ? "" : "s"} (see "Open Findings" in the todo)`);
	}
	const logs = (info.logFiles ?? []).filter((file) => file.trim());
	if (logs.length > 0) {
		lines.push("- Subagent logs (JSONL: prompt, messages, tool calls, result):");
		for (const file of logs) lines.push(`  - ${file}`);
	}
	lines.push("- The uncommitted changes of the attempt are still on disk (see `git status`).");

	lines.push(
		"",
		"Please:",
		"",
		`1. Read the task todo ${info.taskId} (incl. its "Failed Attempts" / "Open Findings" sections) and the uncommitted changes; use the logs if the reason is unclear. Find out why the loop could not finish the task.`,
		"2. Tell me what you found and propose how to proceed. Do not change anything before I agree. Typical ways out:",
		"   - fix the problem here and leave the changes uncommitted,",
		'   - split the task into smaller subtasks (prd-to-todos skill, "Splitting an existing task into subtasks"),',
		"   - rewrite the task if it is wrong or contradictory.",
		"3. When we are done I re-run /prd-loop-pro. It offers this task first: commit & close it, review it again, or re-open it if it was split or rewritten.",
	);
	return lines.join("\n");
}
