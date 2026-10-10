/**
 * PRD Loop Pro — Review-fix cycle state machine (pure, no pi imports).
 *
 * Drives the per-task loop between the review and fix phases:
 *
 *   review → findings ≥ threshold? → fix each (P0 first) → ≥1 fixed? → review …
 *
 * `nextStep(state)` tells the orchestrator what to do next:
 *
 * - `review`  — run review round `round` (fresh reviewer subagent).
 * - `fix`     — run one fixer subagent for exactly one finding.
 * - `commit`  — the cycle converged (no findings at/above the threshold,
 *               no finding fixed in the last round — e.g. all rejected or
 *               unresolved — or the user chose "Commit as-is").
 * - `pause`   — the round limit is reached and the last review still has
 *               open findings at/above the threshold.
 *
 * Rules:
 * - Findings are split by the fix threshold (inclusive: `P1` = fix P0 + P1).
 *   Findings below the threshold are recorded as deferred (deduplicated
 *   across rounds) and never fixed.
 * - Findings at/above the threshold are fixed sequentially in priority order
 *   (P0 → P3, input order kept within a priority).
 * - A re-review happens only if at least one finding of the round was fixed.
 * - Fixes are only applied if a re-review can verify them: when review round
 *   `roundLimit` still reports findings at/above the threshold, the cycle
 *   pauses with those findings instead of fixing them. "One more round"
 *   (`extendRoundLimit`) raises the limit by one, so the findings get fixed
 *   and reviewed again. "Commit as-is" (`commitAsIs`) records them as
 *   unresolved and moves to commit.
 * - Rejected findings (with the fixer's reason) are accumulated across rounds
 *   and passed to the next review prompt (`rejectedForNextReview`).
 * - Unresolved findings (fixer crashed / returned no valid result) of the last
 *   round are reported; earlier rounds are superseded by the re-review.
 *
 * All functions are pure: they never mutate the given state and return a new
 * one. Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import type { FindingPriority, ReviewerResult, ReviewFinding } from "./subagent-result.ts";
import type { FixedFinding, RejectedFinding, UnresolvedFinding } from "./execution-report.ts";

export const PRIORITY_ORDER: readonly FindingPriority[] = ["P0", "P1", "P2", "P3"];

/** True if `priority` is as severe as or more severe than `threshold`. */
export function meetsFixThreshold(priority: FindingPriority, threshold: FindingPriority): boolean {
	return PRIORITY_ORDER.indexOf(priority) <= PRIORITY_ORDER.indexOf(threshold);
}

/** Stable sort by priority (P0 first); input order is kept within a priority. */
export function sortFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
	return findings
		.map((finding, index) => ({ finding, index }))
		.sort((a, b) => {
			const diff = PRIORITY_ORDER.indexOf(a.finding.priority) - PRIORITY_ORDER.indexOf(b.finding.priority);
			return diff !== 0 ? diff : a.index - b.index;
		})
		.map(({ finding }) => finding);
}

/** Split findings into actionable (≥ threshold, sorted P0 → P3) and deferred (below threshold). */
export function splitFindings(
	findings: readonly ReviewFinding[],
	threshold: FindingPriority,
): { actionable: ReviewFinding[]; deferred: ReviewFinding[] } {
	const actionable = sortFindings(findings.filter((finding) => meetsFixThreshold(finding.priority, threshold)));
	const deferred = findings.filter((finding) => !meetsFixThreshold(finding.priority, threshold));
	return { actionable, deferred };
}

/** Outcome of one fixer run. `unresolved` = fixer crashed or returned no valid result. */
export type FixOutcome =
	| { status: "fixed"; summary: string; verification?: string }
	| { status: "rejected"; reason: string; summary?: string }
	| { status: "unresolved"; reason: string };

/** One completed review round and the fixer outcomes for its actionable findings. */
export interface ReviewRound {
	/** 1-based round number. */
	round: number;
	verdict: ReviewerResult["verdict"];
	summary: string;
	/** Findings at/above the threshold, sorted P0 → P3. */
	actionable: ReviewFinding[];
	/** Fixer outcomes, aligned with the prefix of `actionable` that was processed. */
	outcomes: FixOutcome[];
}

export interface ReviewCycleState {
	fixThreshold: FindingPriority;
	/** Current round limit (`maxReviewRounds`, raised by "One more round"). */
	roundLimit: number;
	/** Completed review rounds, oldest first. */
	rounds: ReviewRound[];
	/** Fixed findings across all rounds. */
	fixed: FixedFinding[];
	/** Rejected findings (with reasons) across all rounds. */
	rejected: RejectedFinding[];
	/** Findings below the threshold across all rounds (deduplicated). */
	deferred: ReviewFinding[];
	/** Human reviewer callouts across all rounds. */
	callouts: string[];
	/** Set by `commitAsIs`: findings left open at the round limit. */
	committedAsIs: UnresolvedFinding[] | null;
}

export type CycleStep =
	| { kind: "review"; round: number; roundLimit: number }
	| {
		kind: "fix";
		finding: ReviewFinding;
		round: number;
		/** 1-based position of the finding within the round's actionable findings. */
		index: number;
		/** Number of actionable findings in the round. */
		total: number;
	}
	| { kind: "commit" }
	| { kind: "pause"; reason: "round-limit"; round: number; roundLimit: number; openFindings: ReviewFinding[] };

export interface ReviewCycleOptions {
	fixThreshold: FindingPriority;
	maxReviewRounds: number;
}

/** Initial state: nothing reviewed yet (`nextStep` → review round 1). */
export function createReviewCycle(options: ReviewCycleOptions): ReviewCycleState {
	if (!PRIORITY_ORDER.includes(options.fixThreshold)) {
		throw new Error(`Invalid fix threshold: ${String(options.fixThreshold)}`);
	}
	if (!Number.isInteger(options.maxReviewRounds) || options.maxReviewRounds < 1) {
		throw new Error(`Invalid max review rounds: ${String(options.maxReviewRounds)} (expected integer ≥ 1)`);
	}
	return {
		fixThreshold: options.fixThreshold,
		roundLimit: options.maxReviewRounds,
		rounds: [],
		fixed: [],
		rejected: [],
		deferred: [],
		callouts: [],
		committedAsIs: null,
	};
}

/** Determine the next step of the cycle. */
export function nextStep(state: ReviewCycleState): CycleStep {
	if (state.committedAsIs) return { kind: "commit" };

	const last = state.rounds.at(-1);
	if (!last) return { kind: "review", round: 1, roundLimit: state.roundLimit };

	if (last.actionable.length === 0) return { kind: "commit" };

	const processed = last.outcomes.length;
	if (processed < last.actionable.length) {
		// Only fix if a re-review can still verify the fixes.
		if (processed === 0 && last.round >= state.roundLimit) {
			return {
				kind: "pause",
				reason: "round-limit",
				round: last.round,
				roundLimit: state.roundLimit,
				openFindings: [...last.actionable],
			};
		}
		return {
			kind: "fix",
			finding: last.actionable[processed]!,
			round: last.round,
			index: processed + 1,
			total: last.actionable.length,
		};
	}

	if (last.outcomes.some((outcome) => outcome.status === "fixed")) {
		return { kind: "review", round: last.round + 1, roundLimit: state.roundLimit };
	}
	return { kind: "commit" };
}

function findingKey(finding: ReviewFinding): string {
	return [finding.priority, finding.file.trim(), finding.title.replace(/\s+/g, " ").trim().toLowerCase()].join("|");
}

function mergeDeferred(existing: readonly ReviewFinding[], added: readonly ReviewFinding[]): ReviewFinding[] {
	const seen = new Set(existing.map(findingKey));
	const out = [...existing];
	for (const finding of added) {
		const key = findingKey(finding);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(finding);
	}
	return out;
}

/** Record the result of a review round. Throws if no review is due. */
export function applyReview(
	state: ReviewCycleState,
	review: Pick<ReviewerResult, "verdict" | "summary" | "findings" | "callouts">,
): ReviewCycleState {
	const step = nextStep(state);
	if (step.kind !== "review") throw new Error(`Unexpected review result (next step is "${step.kind}")`);

	const { actionable, deferred } = splitFindings(review.findings, state.fixThreshold);
	return {
		...state,
		rounds: [
			...state.rounds,
			{ round: step.round, verdict: review.verdict, summary: review.summary, actionable, outcomes: [] },
		],
		deferred: mergeDeferred(state.deferred, deferred),
		callouts: [...state.callouts, ...review.callouts],
	};
}

/** Record the outcome of the fixer for the finding returned by `nextStep`. Throws if no fix is due. */
export function applyFixOutcome(state: ReviewCycleState, outcome: FixOutcome): ReviewCycleState {
	const step = nextStep(state);
	if (step.kind !== "fix") throw new Error(`Unexpected fix result (next step is "${step.kind}")`);

	const rounds = state.rounds.slice(0, -1);
	const last = state.rounds.at(-1)!;
	const next: ReviewCycleState = {
		...state,
		rounds: [...rounds, { ...last, outcomes: [...last.outcomes, outcome] }],
	};

	if (outcome.status === "fixed") {
		next.fixed = [...state.fixed, { finding: step.finding, summary: outcome.summary, round: step.round }];
	} else if (outcome.status === "rejected") {
		next.rejected = [
			...state.rejected,
			{ finding: step.finding, reason: outcome.reason.trim() || "(no reason given)", round: step.round },
		];
	}
	return next;
}

/** "One more round": raise the round limit (default by one). */
export function extendRoundLimit(state: ReviewCycleState, by: number = 1): ReviewCycleState {
	if (!Number.isInteger(by) || by < 1) throw new Error(`Invalid round limit extension: ${String(by)}`);
	return { ...state, roundLimit: state.roundLimit + by };
}

/** Findings of the last round that are still open (not yet processed by a fixer). */
export function openFindings(state: ReviewCycleState): ReviewFinding[] {
	const last = state.rounds.at(-1);
	if (!last) return [];
	return last.actionable.slice(last.outcomes.length);
}

export const COMMIT_AS_IS_REASON = "Open at round limit — committed as-is";

/** "Commit as-is": record the open findings as unresolved and move to commit. */
export function commitAsIs(state: ReviewCycleState, reason: string = COMMIT_AS_IS_REASON): ReviewCycleState {
	const last = state.rounds.at(-1);
	const open = openFindings(state).map((finding) => ({ finding, reason, round: last?.round }));
	return { ...state, committedAsIs: open };
}

/** Rejected findings (with fixer reasons) to inject into the next review prompt. */
export function rejectedForNextReview(state: ReviewCycleState): RejectedFinding[] {
	return [...state.rejected];
}

/** Findings at/above the threshold that are still open at the end of the cycle. */
export function unresolvedFindings(state: ReviewCycleState): UnresolvedFinding[] {
	const last = state.rounds.at(-1);
	const out: UnresolvedFinding[] = [];
	if (last) {
		last.outcomes.forEach((outcome, index) => {
			if (outcome.status === "unresolved") {
				out.push({ finding: last.actionable[index]!, reason: outcome.reason, round: last.round });
			}
		});
	}
	if (state.committedAsIs) out.push(...state.committedAsIs);
	return out;
}

/** Counters for the UI. */
export interface CycleCounts {
	round: number;
	roundLimit: number;
	fixed: number;
	rejected: number;
	deferred: number;
	unresolved: number;
}

export function cycleCounts(state: ReviewCycleState): CycleCounts {
	return {
		round: state.rounds.length,
		roundLimit: state.roundLimit,
		fixed: state.fixed.length,
		rejected: state.rejected.length,
		deferred: state.deferred.length,
		unresolved: unresolvedFindings(state).length,
	};
}

/** Review-related fields of the execution report. */
export interface CycleReportFields {
	reviewRounds: number;
	finalVerdict?: ReviewerResult["verdict"];
	reviewSummary?: string;
	fixed: FixedFinding[];
	rejected: RejectedFinding[];
	deferred: ReviewFinding[];
	unresolved: UnresolvedFinding[];
	callouts: string[];
}

export function reportFields(state: ReviewCycleState): CycleReportFields {
	const last = state.rounds.at(-1);
	return {
		reviewRounds: state.rounds.length,
		finalVerdict: last?.verdict,
		reviewSummary: last?.summary,
		fixed: [...state.fixed],
		rejected: [...state.rejected],
		deferred: [...state.deferred],
		unresolved: unresolvedFindings(state),
		callouts: [...state.callouts],
	};
}
