/**
 * PRD Loop Pro — Splitter prompt (pure, no pi imports).
 *
 * Builds the task prompt of the prd-splitter subagent ("Split task" in a
 * pause menu): the task to split, why the loop paused, what the implementer
 * reported and where the changes of the attempt are.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import type { ProposedPart } from "./subagent-result.ts";
import { SPLIT_MAX_SUBTASKS, SPLIT_MIN_SUBTASKS } from "./task-split.ts";

export interface SplitterPromptInput {
	taskTitle: string;
	taskBody: string;
	/** TODO-xxx id of the PRD */
	prdId: string;
	/** Why the loop paused, e.g. "implementation failed after 2 attempts". */
	reason: string;
	errors?: string[];
	/** Summary of the implementer's last result. */
	summary?: string;
	/** Why the implementer reported the task as blocked. */
	blockedReason?: string;
	/** Parts proposed by the implementer. */
	proposedSplit?: ProposedPart[];
	/** True if the attempt left uncommitted changes outside `.pi/`. */
	hasChanges: boolean;
	/** Problems of a previous proposal of this run (the splitter is asked again). */
	previousIssues?: string[];
}

export function buildSplitterPrompt(input: SplitterPromptInput): string {
	const lines = [
		`# Split this task: ${input.taskTitle}`,
		"",
		"An automated implementation run could not complete the task below. Split it into smaller subtasks.",
		"",
		"## Why the run stopped",
		"",
		`- Reason: ${input.reason.trim()}`,
	];
	const errors = (input.errors ?? []).filter((error) => error.trim());
	if (errors.length > 0) {
		lines.push("- Errors:");
		for (const error of errors) lines.push(`  - ${error.replace(/\s+/g, " ").trim()}`);
	}
	if (input.summary?.trim()) lines.push(`- Implementer summary: ${input.summary.trim()}`);
	if (input.blockedReason?.trim()) lines.push(`- The implementer reported the task as blocked: ${input.blockedReason.trim()}`);
	const parts = (input.proposedSplit ?? []).filter((part) => part.title.trim());
	if (parts.length > 0) {
		lines.push("", "The implementer proposed these parts (a starting point; check and improve it):", "");
		parts.forEach((part, i) => {
			lines.push(`${i + 1}. ${part.title.trim()}${part.description.trim() ? ` — ${part.description.trim()}` : ""}`);
		});
	}
	lines.push(
		"",
		input.hasChanges
			? "The uncommitted changes of the attempt are on disk. Inspect them (`git status --porcelain -- . ':(exclude).pi'`, `git diff HEAD -- . ':(exclude).pi'`) to see how far the run got and where it struggled. They will be saved as a git stash and removed before the subtasks start, so every subtask starts from the last commit."
			: "The attempt left no uncommitted changes.",
	);
	if (input.previousIssues && input.previousIssues.length > 0) {
		lines.push("", "Your previous proposal was not usable:", "", ...input.previousIssues.map((issue) => `- ${issue}`));
	}
	lines.push(
		"",
		"## Constraints",
		"",
		`- ${SPLIT_MIN_SUBTASKS} to ${SPLIT_MAX_SUBTASKS} subtasks, in execution order; \`dependsOn\` may only name earlier subtasks.`,
		"- Together, the subtasks and the close-out of the original task must cover every acceptance criterion of the task. Do not add scope.",
		"",
		"## The task",
		"",
		input.taskBody.trim(),
		"",
		"---",
		"",
		`If you need more context about the overall project, read the PRD todo: ${input.prdId} (file \`.pi/todos/${input.prdId.replace(/^TODO-/, "")}.md\`).`,
	);
	return lines.join("\n");
}
