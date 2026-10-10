/**
 * PRD Loop Pro — Unified pause menu (pure, no pi imports).
 *
 * Every situation in which the loop hands control to the human goes through
 * one menu model: the reason and the current phase decide which actions are
 * offered, and the menu title always states the task, the phase and the
 * reason (plus errors / details).
 *
 * Pause reasons and their actions:
 *
 * | Reason                  | Actions                                                                 |
 * |-------------------------|-------------------------------------------------------------------------|
 * | manual (Ctrl+C)         | Resume current phase, Skip phase*, Retry task, Release, Skip task, Abort |
 * | implementation-failed   | Retry task, Release, Skip task, Abort                                   |
 * | invalid-result (JSON)   | Retry phase, Release, Skip task, Abort                                  |
 * | phase-failed            | Retry phase, Release, Skip task, Abort                                  |
 * | committer-failed        | Retry phase, Release, Skip task, Abort                                  |
 * | hook-failed             | Retry phase, Release, Skip task, Abort                                  |
 * | round-limit             | One more round, Commit as-is, Release, Skip task, Abort                 |
 *
 * (*) "Skip phase" is never offered during the commit phase: the uncommitted
 * changes would leak into the next task.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

/** Pipeline phase in which the loop paused. */
export type PausePhase = "Implement" | "Review" | "Fix" | "Commit";

/** Why the loop paused. */
export type PauseReasonKind =
	| "manual"
	| "implementation-failed"
	| "invalid-result"
	| "phase-failed"
	| "committer-failed"
	| "hook-failed"
	| "round-limit";

/** Action the human can choose in a pause menu. */
export type PauseAction =
	| "resume"
	| "skip-phase"
	| "retry-phase"
	| "retry-task"
	| "one-more-round"
	| "commit-as-is"
	| "release"
	| "skip-task"
	| "abort";

export interface PauseRequest {
	/** Display label of the task, e.g. "Task 2/5: Add settings". */
	taskLabel: string;
	phase: PausePhase;
	/** Phase label incl. progress (e.g. "Review 2/3", "Fix 1/2 [P1] Title"); defaults to `phase`. */
	phaseLabel?: string;
	reason: PauseReasonKind;
	/** Human-readable reason; defaults to `defaultReasonText(reason, phase)`. */
	reasonText?: string;
	/** Errors of the failed phase (listed in the title). */
	errors?: string[];
	/** Additional lines shown below the reason (e.g. open findings). */
	details?: string[];
}

export interface PauseMenuOption {
	action: PauseAction;
	label: string;
}

export interface PauseMenu {
	title: string;
	options: PauseMenuOption[];
	/**
	 * Action chosen when the dialog is cancelled. `undefined` = show the menu
	 * again (every offered action has a cost or consequence).
	 */
	cancelAction?: PauseAction;
}

/** Maximum number of errors listed in the menu title. */
export const PAUSE_MAX_LISTED_ERRORS = 5;
/** Maximum length of one listed error (longer errors are truncated). */
export const PAUSE_MAX_ERROR_LENGTH = 300;

/** Label of the "Release" option (shared by all pause menus). */
export const RELEASE_LABEL = "🔧 Release (fix manually) — mark task needs-human, stop the loop, resolve at next start";

/** Actions offered for a pause reason in a phase. */
export function pauseActions(reason: PauseReasonKind, phase: PausePhase): PauseAction[] {
	switch (reason) {
		case "manual":
			return phase === "Commit"
				? ["resume", "retry-task", "release", "skip-task", "abort"]
				: ["resume", "skip-phase", "retry-task", "release", "skip-task", "abort"];
		case "implementation-failed":
			return ["retry-task", "release", "skip-task", "abort"];
		case "round-limit":
			return ["one-more-round", "commit-as-is", "release", "skip-task", "abort"];
		case "invalid-result":
		case "phase-failed":
		case "committer-failed":
		case "hook-failed":
			return ["retry-phase", "release", "skip-task", "abort"];
	}
}

/** Name of the subagent that runs in a phase. */
export function phaseAgentName(phase: PausePhase): string {
	switch (phase) {
		case "Implement": return "implementer";
		case "Review": return "reviewer";
		case "Fix": return "fixer";
		case "Commit": return "committer";
	}
}

/** Default human-readable reason text. */
export function defaultReasonText(reason: PauseReasonKind, phase: PausePhase): string {
	switch (reason) {
		case "manual": return "manual pause (Ctrl+C)";
		case "implementation-failed": return "implementation failed after all retries";
		case "invalid-result": return `JSON repair failed — the ${phaseAgentName(phase)} returned no valid result`;
		case "phase-failed": return `${phase.toLowerCase()} phase failed`;
		case "committer-failed": return "committer failed";
		case "hook-failed": return "git hook failed";
		case "round-limit": return "review round limit reached";
	}
}

/** Menu label of an action (some labels depend on the phase). */
export function pauseActionLabel(action: PauseAction, phase: PausePhase): string {
	switch (action) {
		case "resume":
			switch (phase) {
				case "Implement": return "🟢 Resume current phase — keep changes, continue the implementation where it left off";
				case "Review": return "🟢 Resume current phase — keep changes, restart the review";
				case "Fix": return "🟢 Resume current phase — keep changes, restart the fix of this finding";
				case "Commit": return "🟢 Resume current phase — keep changes, run the committer again";
			}
			break;
		case "skip-phase":
			switch (phase) {
				case "Implement": return "⏩ Skip phase — keep changes, continue with the review";
				case "Review": return "⏩ Skip phase — skip the review, continue with the commit";
				case "Fix": return "⏩ Skip phase — leave this finding unresolved, continue with the next step";
				case "Commit": return "⏩ Skip phase";
			}
			break;
		case "retry-phase":
			return `🔁 Retry phase — keep changes, run the ${phaseAgentName(phase)} again`;
		case "retry-task":
			return "🔄 Retry task — discard changes (except .pi/), restart at implement";
		case "one-more-round":
			return "🔁 One more round — fix the open findings and review again";
		case "commit-as-is":
			return "✅ Commit as-is & close task — open findings go into the report";
		case "release":
			return RELEASE_LABEL;
		case "skip-task":
			return "🚮 Skip task — discard changes (except .pi/), mark done, continue with next";
		case "abort":
			return "❌ Abort loop — stop and keep changes on disk";
	}
	return action;
}

/** Truncate a single-line error for the menu title. */
function formatError(error: string): string {
	const clean = error.replace(/\s+/g, " ").trim();
	return clean.length <= PAUSE_MAX_ERROR_LENGTH ? clean : `${clean.slice(0, PAUSE_MAX_ERROR_LENGTH - 1)}…`;
}

/** Menu title: task, phase, reason, errors and details. */
export function buildPauseTitle(request: PauseRequest): string {
	const reasonText = request.reasonText ?? defaultReasonText(request.reason, request.phase);
	const lines = [
		`⏸️  Paused — ${request.taskLabel}`,
		`Phase: ${request.phaseLabel ?? request.phase}`,
		`Reason: ${reasonText}`,
	];

	const errors = (request.errors ?? []).filter((e) => e.trim() !== "");
	if (errors.length > 0) {
		lines.push("", "Errors:");
		for (const error of errors.slice(0, PAUSE_MAX_LISTED_ERRORS)) lines.push(`  • ${formatError(error)}`);
		if (errors.length > PAUSE_MAX_LISTED_ERRORS) {
			lines.push(`  … and ${errors.length - PAUSE_MAX_LISTED_ERRORS} more`);
		}
	}

	if (request.details && request.details.length > 0) lines.push("", ...request.details);
	return lines.join("\n");
}

/** Complete pause menu for a request. */
export function buildPauseMenu(request: PauseRequest): PauseMenu {
	const options = pauseActions(request.reason, request.phase).map((action) => ({
		action,
		label: pauseActionLabel(action, request.phase),
	}));
	return {
		title: buildPauseTitle(request),
		options,
		// A manual pause is cancelled by resuming; all other menus are shown again.
		cancelAction: request.reason === "manual" ? "resume" : undefined,
	};
}

/** Release reason recorded in the task todo when "Release" is chosen. */
export function releaseReasonFor(request: Pick<PauseRequest, "phase" | "reason" | "reasonText">): string {
	if (request.reason === "manual") return `manual pause during ${request.phase.toLowerCase()}`;
	return request.reasonText ?? defaultReasonText(request.reason, request.phase);
}

/** Summary of a task skipped from a pause menu. */
export function skipSummaryFor(request: Pick<PauseRequest, "phase" | "reason" | "reasonText">): string {
	if (request.reason === "manual") return `Skipped after a manual pause during ${request.phase.toLowerCase()}.`;
	return `Skipped after the loop paused: ${request.reasonText ?? defaultReasonText(request.reason, request.phase)}.`;
}
