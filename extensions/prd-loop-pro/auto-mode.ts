/**
 * PRD Loop Pro — Auto mode (pure, no pi imports).
 *
 * In auto mode the orchestrator answers some pause menus instead of the
 * human: a read-only decider subagent (prd-decider, orchestrator model +
 * thinking level) picks one of the offered actions and gives a reason.
 *
 * Which pauses are decided automatically:
 *
 * | Reason                | Actions the decider may pick                               |
 * |-----------------------|------------------------------------------------------------|
 * | task-blocked          | Split task, Retry phase, Retry task, Release               |
 * | implementation-failed | Retry phase, Retry task, Split task, Release               |
 * | round-limit           | One more round, Commit as-is, Release                      |
 *
 * Every other pause (manual Ctrl+C, invalid JSON, crashed phase, committer or
 * hook failure) always waits for the human.
 *
 * Guard rails, so auto mode cannot run in circles:
 * - "Abort", "Skip task", "Resume" and "Skip phase" are never picked.
 * - At most AUTO_MAX_DECISIONS_PER_TASK decisions per task; afterwards the
 *   human decides.
 * - "Retry phase", "Retry task", "One more round" and "Split task" are picked
 *   at most AUTO_ACTION_LIMITS times per task.
 * - "Split task" only while the subtasks stay within AUTO_MAX_SPLIT_DEPTH
 *   (17 → 17a → 17a1, but 17a1 is not split again automatically).
 * - If nothing but "Release" is left, the human decides (the menu is shown).
 * - If the decider fails or picks an action that is not offered, the menu is
 *   shown.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import { attemptActionText } from "./attempt-log.ts";
import { pauseActions } from "./pause.ts";
import type { PauseAction, PausePhase, PauseReasonKind } from "./pause.ts";
import type { DeciderResult, ProposedPart } from "./subagent-result.ts";
import { sequenceDepth, sequenceSegments } from "./task-sequence.ts";

/** Pause reasons the orchestrator decides in auto mode. */
export const AUTO_DECIDABLE_REASONS: readonly PauseReasonKind[] = ["task-blocked", "implementation-failed", "round-limit"];

/** Actions the decider never picks (destructive, or only meaningful after a manual pause). */
export const AUTO_EXCLUDED_ACTIONS: readonly PauseAction[] = ["abort", "skip-task", "resume", "skip-phase"];

/** Maximum number of automatic decisions per task. */
export const AUTO_MAX_DECISIONS_PER_TASK = 4;

/** How often an action may be picked automatically per task. */
export const AUTO_ACTION_LIMITS: Partial<Record<PauseAction, number>> = {
	"retry-phase": 1,
	"retry-task": 1,
	"one-more-round": 1,
	"split-task": 1,
};

/**
 * Deepest sequence label a split may create automatically (0 = "17",
 * 1 = "17a", 2 = "17a1"). A task is only split if its subtasks stay within it.
 */
export const AUTO_MAX_SPLIT_DEPTH = 2;

/** Maximum length of the task body included in the decider prompt. */
export const DECIDER_MAX_BODY_CHARS = 12000;

/** One automatic decision (kept per task, passed to later decisions). */
export interface AutoDecisionRecord {
	reason: string;
	action: PauseAction;
	rationale: string;
}

/** Auto mode bookkeeping of one task. */
export interface AutoTaskState {
	decisions: AutoDecisionRecord[];
}

export function createAutoTaskState(): AutoTaskState {
	return { decisions: [] };
}

export function isAutoDecidable(reason: PauseReasonKind): boolean {
	return AUTO_DECIDABLE_REASONS.includes(reason);
}

/** How often an action was already picked automatically for the task. */
export function autoActionCount(state: AutoTaskState, action: PauseAction): number {
	return state.decisions.filter((decision) => decision.action === action).length;
}

/** Whether a task with this sequence label may be split automatically. */
export function canAutoSplit(sequenceLabel: string): boolean {
	if (sequenceSegments(sequenceLabel).length === 0) return false;
	return sequenceDepth(sequenceLabel) + 1 <= AUTO_MAX_SPLIT_DEPTH;
}

export interface AutoCandidatesInput {
	reason: PauseReasonKind;
	phase: PausePhase;
	sequenceLabel: string;
	state: AutoTaskState;
}

/**
 * Actions the decider may pick for a pause, in menu order. Empty = the human
 * decides (pause not decidable, budget used up, or only "Release" left).
 */
export function autoCandidateActions(input: AutoCandidatesInput): PauseAction[] {
	if (!isAutoDecidable(input.reason)) return [];
	if (input.state.decisions.length >= AUTO_MAX_DECISIONS_PER_TASK) return [];
	const candidates = pauseActions(input.reason, input.phase).filter((action) => {
		if (AUTO_EXCLUDED_ACTIONS.includes(action)) return false;
		const limit = AUTO_ACTION_LIMITS[action];
		if (limit !== undefined && autoActionCount(input.state, action) >= limit) return false;
		if (action === "split-task" && !canAutoSplit(input.sequenceLabel)) return false;
		return true;
	});
	if (candidates.every((action) => action === "release")) return [];
	return candidates;
}

/** What an action does, written for the decider (with guidance when to pick it). */
export function deciderActionGuide(action: PauseAction, reason: PauseReasonKind): string {
	switch (action) {
		case "split-task":
			return "A planning agent splits the task into 2–12 smaller subtasks; the changes of this attempt are saved as a git stash and removed, the loop continues with the subtasks. Pick it when the task is too large or too broad for one run, or when a missing prerequisite can itself be built as an earlier subtask.";
		case "retry-phase":
			return reason === "task-blocked"
				? "Run the implementer again on the changes on disk, told that it reported the task as blocked. Pick it only if the blocker looks like a misjudgement the implementer can overcome in one more run (e.g. the information it missed is in the codebase or the PRD)."
				: "Run the implementer again on the changes on disk, with the errors of the failed attempt. Pick it when the remaining errors look concrete and fixable in one more run (a few failing tests, type errors, lint) and the attempt made progress.";
		case "retry-task":
			return "Discard the changes (saved as a git stash) and start the task from scratch. Pick it when the attempt went in a wrong direction and a fresh start is more promising than continuing on the changes on disk.";
		case "one-more-round":
			return "Run the fixer for the open findings and review again (raises the round limit by one). Pick it when the open findings are concrete, fixable, and the review rounds so far made progress.";
		case "commit-as-is":
			return "Commit the changes now; the open findings are recorded as unresolved in the execution report. Pick it only if every open finding is low-impact or very likely a false positive — never with an open P0 or a real correctness, security or data-loss problem.";
		case "release":
			return "Stop the loop and hand the task over to a human (needs-human, changes kept). Pick it when a human decision, credentials, an external system or a product question is needed, when the same problem keeps coming back, or when no other option is clearly better.";
		default:
			return attemptActionText(action);
	}
}

export interface DeciderPromptInput {
	taskTitle: string;
	/** Current task body (incl. `## Failed Attempts`). */
	taskBody: string;
	/** TODO-xxx id of the PRD. */
	prdId: string;
	phase: PausePhase;
	/** Phase label incl. progress, e.g. "Review 3/3 — round limit". */
	phaseLabel: string;
	reason: PauseReasonKind;
	reasonText: string;
	errors?: string[];
	/** Detail lines of the pause (e.g. open findings, the implementer's split proposal). */
	details?: string[];
	/** Summary of the last subagent result. */
	summary?: string;
	blockedReason?: string;
	proposedSplit?: ProposedPart[];
	/** Actions the decider may pick (see `autoCandidateActions`). */
	candidates: PauseAction[];
	/** Earlier automatic decisions for this task. */
	previousDecisions: AutoDecisionRecord[];
	/** True if the attempt left uncommitted changes outside `.pi/`. */
	hasChanges: boolean;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function buildDeciderPrompt(input: DeciderPromptInput): string {
	const lines = [
		`# Decide how the loop continues: ${input.taskTitle}`,
		"",
		"The automated PRD loop paused on the task below. Auto mode is on, so you decide instead of the human: pick exactly one of the offered actions.",
		"",
		"## Why the loop paused",
		"",
		`- Phase: ${input.phaseLabel}`,
		`- Reason: ${oneLine(input.reasonText)}`,
	];
	const errors = (input.errors ?? []).filter((error) => error.trim());
	if (errors.length > 0) {
		lines.push("- Errors:");
		for (const error of errors) lines.push(`  - ${oneLine(error)}`);
	}
	if (input.summary?.trim()) lines.push(`- Last summary of the subagent: ${oneLine(input.summary)}`);
	if (input.blockedReason?.trim()) lines.push(`- The implementer reported the task as blocked: ${oneLine(input.blockedReason)}`);
	const parts = (input.proposedSplit ?? []).filter((part) => part.title.trim());
	if (parts.length > 0) {
		lines.push("", "The implementer proposed this split:", "");
		parts.forEach((part, i) => {
			lines.push(`${i + 1}. ${oneLine(part.title)}${part.description.trim() ? ` — ${oneLine(part.description)}` : ""}`);
		});
	}
	// The details of a blocked task repeat the proposed split listed above.
	const details = input.reason === "task-blocked" ? [] : (input.details ?? []).filter((line) => line.trim());
	if (details.length > 0) lines.push("", ...details);

	lines.push(
		"",
		input.hasChanges
			? "The uncommitted changes of the attempt are on disk. Inspect them if it helps the decision (`git status --porcelain -- . ':(exclude).pi'`, `git diff HEAD -- . ':(exclude).pi'`)."
			: "There are no uncommitted changes outside `.pi/`.",
	);

	if (input.previousDecisions.length > 0) {
		lines.push("", "## Earlier automatic decisions for this task", "");
		for (const decision of input.previousDecisions) {
			lines.push(`- ${oneLine(decision.reason)} → \`${decision.action}\`${decision.rationale.trim() ? ` — ${oneLine(decision.rationale)}` : ""}`);
		}
		lines.push("", "Don't repeat an approach that already failed for the same reason.");
	}

	lines.push("", "## Offered actions", "", "Pick exactly one of these ids:", "");
	for (const action of input.candidates) lines.push(`- \`${action}\` — ${deciderActionGuide(action, input.reason)}`);

	let body = input.taskBody.trim();
	if (body.length > DECIDER_MAX_BODY_CHARS) body = `${body.slice(0, DECIDER_MAX_BODY_CHARS)}\n…(truncated)…`;
	lines.push(
		"",
		"## The task",
		"",
		body,
		"",
		"---",
		"",
		`If you need more context about the overall project, read the PRD todo: ${input.prdId} (file \`.pi/todos/${input.prdId.replace(/^TODO-/, "")}.md\`).`,
	);
	return lines.join("\n");
}

export type DecisionValidation =
	| { ok: true; action: PauseAction; rationale: string }
	| { ok: false; error: string };

/** Check the decider's answer against the offered actions. */
export function validateDecision(result: DeciderResult, candidates: readonly PauseAction[]): DecisionValidation {
	const action = result.action.trim().toLowerCase().replace(/[`"']/g, "") as PauseAction;
	if (!candidates.includes(action)) {
		return {
			ok: false,
			error: `the decider picked "${result.action}", which is not one of the offered actions (${candidates.join(", ")})`,
		};
	}
	return { ok: true, action, rationale: oneLine(result.rationale) };
}

/** Action text for the attempt log when auto mode picked the action. */
export function autoAttemptActionText(action: PauseAction, rationale: string): string {
	const base = attemptActionText(action);
	return rationale ? `${base} — chosen by auto mode: ${rationale}` : `${base} — chosen by auto mode`;
}
