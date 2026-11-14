/**
 * PRD Loop Pro — Subagent run logs (no pi imports).
 *
 * Subagents run with `--no-session`, so without a log nobody can tell later
 * why a run failed. Every subagent run is therefore written to a JSONL file:
 *
 *   <agent dir>/prd-loop-pro/logs/<project>/<run timestamp>/<nnn>-<task>-<phase>.jsonl
 *
 * The logs live outside the project, so they never show up in `git status`
 * and are never reviewed, committed or discarded. A log holds a `run_start`
 * record (agent, model, prompt), the completed messages (`message_end`, incl.
 * tool calls and tool results), compaction / auto-retry events and a
 * `run_end` record (status, error, usage, stderr). Streaming deltas are left
 * out.
 *
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** Number of run directories kept per project. */
export const RUN_LOG_KEEP_RUNS = 30;

/** Event types written to the log. */
const LOGGED_EVENT_TYPES = new Set([
	"message_end",
	"agent_end",
	"agent_settled",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
]);

/** File-system safe slug (lowercase, `-` separated). */
export function slugify(text: string, maxLength = 60): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.slice(0, maxLength).replace(/-+$/, "") || "x";
}

/** Directory holding all runs of a project: `<base>/<project slug>`. */
export function projectLogDir(baseDir: string, cwd: string): string {
	return join(baseDir, slugify(cwd, 120));
}

/** Directory name of one loop run, e.g. `2026-11-13T22-30-50`. */
export function runDirName(now: Date): string {
	return now.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

/** Log file name of one subagent run, e.g. `004-17a1-20-implement-attempt-2.jsonl`. */
export function runLogFileName(sequence: number, taskLabel: string, phaseHeader: string): string {
	return `${String(sequence).padStart(3, "0")}-${slugify(taskLabel, 20)}-${slugify(phaseHeader, 40)}.jsonl`;
}

/**
 * Reduce a raw subagent JSON event to its log record, or `undefined` if the
 * event is not logged. `agent_end` is logged without its messages (they are
 * already logged one by one as `message_end`).
 */
export function toLogRecord(event: unknown): Record<string, unknown> | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as Record<string, unknown>;
	if (typeof record.type !== "string" || !LOGGED_EVENT_TYPES.has(record.type)) return undefined;
	if (record.type === "agent_end") {
		const { messages: _messages, ...rest } = record;
		return rest;
	}
	return record;
}

/** Append one record to a log file (creates the directory). Never throws. */
export function appendLogRecord(logPath: string, record: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
	} catch {
		// Logging must never break a run.
	}
}

/** Remove the oldest run directories of a project, keeping the newest `keep`. Never throws. */
export function pruneRunDirs(projectDir: string, keep = RUN_LOG_KEEP_RUNS): void {
	try {
		const runs = readdirSync(projectDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
			rmSync(join(projectDir, name), { recursive: true, force: true });
		}
	} catch {
		// Nothing to prune.
	}
}
