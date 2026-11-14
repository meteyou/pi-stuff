/**
 * PRD Loop Pro — Persisted task statistics (pure, no pi imports).
 *
 * The loop stores what it spent on a task in the task todo, so the numbers
 * survive a restart: the active time, and one record per subagent run with
 * its phase, session id, model, duration, tokens and cost. They live in the
 * JSON front matter of the todo under `prd_loop` (never in the markdown body,
 * which agents read):
 *
 *   "prd_loop": {"version":1,"active_ms":754000,"runs":[{"phase":"implement",
 *     "label":"Implement","session":"<id>","model":"anthropic/x · low",
 *     "started_at":"2026-11-14T10:00:00.000Z","duration_ms":600000,"cost":1.2,
 *     "tokens":{"input":1,"output":2,"cache_read":3,"cache_write":4}}],
 *     "review":{"round":1,"roundLimit":5,...}}
 *
 * - `active_ms` is the time the loop worked on the task. Time spent waiting
 *   for the human in a dialog (pause menu, split confirmation) is not counted.
 * - `session` is the id of the stored pi session of the run; `pi --session
 *   <id>` (or the "sessions" action in `/todos`) opens it.
 * - Stored strings never contain braces: `/prd-loop` finds the end of the
 *   front matter by counting them.
 *
 * Parsing is tolerant: anything unusable is dropped, never thrown.
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import type { CostPhase } from "./execution-report.ts";
import { COST_PHASES } from "./execution-report.ts";
import type { TaskReviewProgress } from "./progress-view.ts";

/** Front matter key of the statistics. */
export const STATS_KEY = "prd_loop";
export const STATS_VERSION = 1;

export interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** One subagent run. */
export interface RunRecord {
	phase: CostPhase;
	/** Phase header of the run, e.g. `Implement (attempt 2)` or `Fix #1 • 3 findings`. */
	label: string;
	/** Id of the stored pi session of the run. */
	session?: string;
	/** Model + thinking level the run was started with. */
	model?: string;
	/** ISO timestamp of the start. */
	startedAt: string;
	durationMs: number;
	/** Cost in USD (incl. a JSON repair of the result). */
	cost: number;
	tokens: TokenCounts;
	/** True if the run failed (crash, invalid result, failed implementation, pause). */
	failed?: boolean;
}

export interface TaskStats {
	/** Time the loop worked on the task, without the time spent in dialogs. */
	activeMs: number;
	runs: RunRecord[];
	/** Review-fix progress of the last pipeline run. */
	review?: TaskReviewProgress;
}

export function emptyTokens(): TokenCounts {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function emptyStats(): TaskStats {
	return { activeMs: 0, runs: [] };
}

export function hasStats(stats: TaskStats): boolean {
	return stats.activeMs > 0 || stats.runs.length > 0;
}

// --- Totals ---

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
	};
}

export function totalTokens(tokens: TokenCounts): number {
	return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

export interface StatsTotals {
	cost: number;
	tokens: TokenCounts;
	runs: number;
}

export function statsTotals(stats: TaskStats): StatsTotals {
	return stats.runs.reduce<StatsTotals>(
		(sum, run) => ({ cost: sum.cost + run.cost, tokens: addTokens(sum.tokens, run.tokens), runs: sum.runs + 1 }),
		{ cost: 0, tokens: emptyTokens(), runs: 0 },
	);
}

/** Cost per phase (same shape as the live per-phase cost of the loop). */
export function phaseCostsOf(stats: TaskStats): Partial<Record<CostPhase, number>> {
	const costs: Partial<Record<CostPhase, number>> = {};
	for (const run of stats.runs) {
		if (run.cost > 0) costs[run.phase] = (costs[run.phase] ?? 0) + run.cost;
	}
	return costs;
}

// --- Formatting ---

/** Compact token count: `950`, `12.3k`, `4.56M`. */
export function formatTokenCount(count: number): string {
	const value = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
	if (value < 1000) return String(value);
	if (value < 999_950) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

/** `1.2M in • 85.0k out • 30.1M cache read • 2.4M cache write` (zero parts are left out). */
export function formatTokens(tokens: TokenCounts): string {
	const parts: string[] = [];
	if (tokens.input > 0) parts.push(`${formatTokenCount(tokens.input)} in`);
	if (tokens.output > 0) parts.push(`${formatTokenCount(tokens.output)} out`);
	if (tokens.cacheRead > 0) parts.push(`${formatTokenCount(tokens.cacheRead)} cache read`);
	if (tokens.cacheWrite > 0) parts.push(`${formatTokenCount(tokens.cacheWrite)} cache write`);
	return parts.length > 0 ? parts.join(" • ") : "0";
}

// --- JSON (front matter) ---

/** Remove characters that must not appear in stored strings (braces, control characters). */
function cleanString(value: string, maxLength = 200): string {
	return value
		.replace(/[{}]/g, "")
		.replace(/[\u0000-\u001f]+/g, " ")
		.trim()
		.slice(0, maxLength);
}

const nonNegative = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Front matter value of the statistics (snake_case keys, numbers rounded). */
export function statsToJson(stats: TaskStats): Record<string, unknown> {
	const round = (value: number, digits: number) => Number(nonNegative(value).toFixed(digits));
	const json: Record<string, unknown> = {
		version: STATS_VERSION,
		active_ms: Math.round(nonNegative(stats.activeMs)),
		runs: stats.runs.map((run) => {
			const record: Record<string, unknown> = { phase: run.phase, label: cleanString(run.label) };
			if (run.session) record.session = cleanString(run.session);
			if (run.model) record.model = cleanString(run.model);
			record.started_at = cleanString(run.startedAt, 40);
			record.duration_ms = Math.round(nonNegative(run.durationMs));
			record.cost = round(run.cost, 6);
			record.tokens = {
				input: Math.round(nonNegative(run.tokens.input)),
				output: Math.round(nonNegative(run.tokens.output)),
				cache_read: Math.round(nonNegative(run.tokens.cacheRead)),
				cache_write: Math.round(nonNegative(run.tokens.cacheWrite)),
			};
			if (run.failed) record.failed = true;
			return record;
		}),
	};
	if (stats.review) {
		const review = stats.review;
		json.review = {
			round: review.round,
			roundLimit: review.roundLimit,
			fixed: review.fixed,
			rejected: review.rejected,
			deferred: review.deferred,
			unresolved: review.unresolved,
			...(review.verdict ? { verdict: review.verdict } : {}),
			...(review.callouts ? { callouts: review.callouts } : {}),
		};
	}
	return json;
}

function parseReview(value: unknown): TaskReviewProgress | undefined {
	if (!isObject(value)) return undefined;
	const round = nonNegative(value.round);
	const roundLimit = nonNegative(value.roundLimit);
	if (round < 1 || roundLimit < 1) return undefined;
	const review: TaskReviewProgress = {
		round,
		roundLimit,
		fixed: nonNegative(value.fixed),
		rejected: nonNegative(value.rejected),
		deferred: nonNegative(value.deferred),
		unresolved: nonNegative(value.unresolved),
	};
	if (value.verdict === "correct" || value.verdict === "needs attention") review.verdict = value.verdict;
	if (nonNegative(value.callouts) > 0) review.callouts = nonNegative(value.callouts);
	return review;
}

/** Read the statistics from a front matter value. Unusable parts are dropped. */
export function parseStats(value: unknown): TaskStats {
	const stats = emptyStats();
	if (!isObject(value)) return stats;
	stats.activeMs = nonNegative(value.active_ms);
	if (Array.isArray(value.runs)) {
		for (const item of value.runs) {
			if (!isObject(item)) continue;
			if (typeof item.phase !== "string" || !(COST_PHASES as readonly string[]).includes(item.phase)) continue;
			const tokens = isObject(item.tokens) ? item.tokens : {};
			const run: RunRecord = {
				phase: item.phase as CostPhase,
				label: typeof item.label === "string" ? item.label : item.phase,
				startedAt: typeof item.started_at === "string" ? item.started_at : "",
				durationMs: nonNegative(item.duration_ms),
				cost: nonNegative(item.cost),
				tokens: {
					input: nonNegative(tokens.input),
					output: nonNegative(tokens.output),
					cacheRead: nonNegative(tokens.cache_read),
					cacheWrite: nonNegative(tokens.cache_write),
				},
			};
			if (typeof item.session === "string" && item.session.trim()) run.session = item.session.trim();
			if (typeof item.model === "string" && item.model.trim()) run.model = item.model;
			if (item.failed === true) run.failed = true;
			stats.runs.push(run);
		}
	}
	const review = parseReview(value.review);
	if (review) stats.review = review;
	return stats;
}

/**
 * Serialize todo front matter: the usual fields pretty-printed (2 spaces),
 * the statistics compact on a single line so they don't push the todo body
 * out of sight.
 */
export function serializeFrontMatter(meta: Record<string, unknown>): string {
	if (!isObject(meta[STATS_KEY])) return JSON.stringify(meta, null, 2);
	const placeholder = "@@prd-loop-stats@@";
	const pretty = JSON.stringify({ ...meta, [STATS_KEY]: placeholder }, null, 2);
	return pretty.replace(JSON.stringify(placeholder), () => JSON.stringify(meta[STATS_KEY]));
}

// --- Sessions ---

/** A run with a stored session, for the session picker in `/todos`. */
export interface SessionChoice {
	session: string;
	/** `1. Implement (attempt 2) — 12:34 • $1.20 • anthropic/x · low • 2026-11-14 10:00 UTC` */
	label: string;
}

/** Runs of a task that have a stored session, oldest first. */
export function sessionChoices(
	stats: TaskStats,
	format: { duration: (ms: number) => string; time?: (iso: string) => string },
): SessionChoice[] {
	const time = format.time ?? ((iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`);
	return stats.runs
		.filter((run) => run.session)
		.map((run, index) => {
			const parts = [format.duration(run.durationMs), `$${run.cost.toFixed(2)}`];
			if (run.model) parts.push(run.model);
			if (run.startedAt) parts.push(time(run.startedAt));
			return {
				session: run.session!,
				label: `${index + 1}. ${run.label}${run.failed ? " ✗" : ""} — ${parts.join(" • ")}`,
			};
		});
}
