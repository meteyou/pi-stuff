/**
 * PRD Loop Pro — Failed attempt log in the task todo (pure, no pi imports).
 *
 * Every pause that is a failure (or that ends with a destructive / final
 * action) is recorded in the task todo under `## Failed Attempts`: phase,
 * reason, errors, the implementer's summary, the chosen action, the snapshot
 * of discarded changes and the subagent log files. The record survives
 * "Retry task", "Skip task" and "Abort", so a later session can see why a
 * task did not go through.
 *
 * The output depends only on the given entry (the timestamp is passed in).
 * Only erasable TypeScript syntax is used (`node --test` type stripping).
 */

import type { PauseAction, PauseReasonKind } from "./pause.ts";

export const FAILED_ATTEMPTS_HEADING = "## Failed Attempts";

/** Maximum length of one recorded error / summary (longer texts are truncated). */
export const ATTEMPT_MAX_TEXT_LENGTH = 2000;

export interface AttemptEntry {
	/** Local timestamp, e.g. "2026-11-13 23:30". */
	timestamp: string;
	/** Phase label incl. progress, e.g. "Implement (attempt 2)" or "Review 2/3". */
	phase: string;
	/** Human-readable pause reason. */
	reason: string;
	/** What the human chose, e.g. "Retry task (changes discarded)". */
	action: string;
	errors?: string[];
	/** Summary of the last subagent result (e.g. the implementer's summary). */
	summary?: string;
	/** Snapshot of the discarded changes (git stash). */
	snapshot?: { ref: string; message: string };
	/** Subagent log files of the attempt. */
	logFiles?: string[];
}

/**
 * Whether a pause is recorded: every failure pause, and manual / round-limit
 * pauses only when they end the attempt (discard, release, split or abort).
 */
export function shouldRecordAttempt(reason: PauseReasonKind, action: PauseAction): boolean {
	if (reason !== "manual" && reason !== "round-limit") return true;
	return action === "retry-task" || action === "skip-task" || action === "split-task" || action === "release" || action === "abort";
}

/** Past-tense description of a pause action for the attempt log. */
export function attemptActionText(action: PauseAction): string {
	switch (action) {
		case "resume": return "Resumed the phase (changes kept)";
		case "skip-phase": return "Skipped the phase (changes kept)";
		case "retry-phase": return "Retried the phase (changes kept)";
		case "retry-task": return "Retry task (changes discarded, restarted at implement)";
		case "one-more-round": return "One more review round";
		case "commit-as-is": return "Committed as-is";
		case "split-task": return "Split into subtasks (changes discarded)";
		case "release": return "Released / handed over to a human (changes kept on disk)";
		case "skip-task": return "Skip task (changes discarded, task marked done)";
		case "abort": return "Loop aborted (changes kept on disk)";
	}
}

function clip(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= ATTEMPT_MAX_TEXT_LENGTH ? trimmed : `${trimmed.slice(0, ATTEMPT_MAX_TEXT_LENGTH - 1)}…`;
}

/** Text as a list item whose continuation lines stay inside the item. */
function listItem(text: string, indent: string): string {
	const [first, ...rest] = clip(text).split("\n");
	const lines = [`${indent}- ${first!.trimEnd()}`];
	for (const line of rest) lines.push(line.trim() ? `${indent}  ${line.trimEnd()}` : "");
	return lines.join("\n");
}

/** Markdown of one attempt (a `###` block). */
export function buildAttemptEntry(entry: AttemptEntry): string {
	const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
	const out = [`### ${entry.timestamp} — ${oneLine(entry.phase)}: ${oneLine(entry.reason)}`, ""];
	out.push(`- **Action:** ${oneLine(entry.action)}`);
	if (entry.snapshot) {
		out.push(
			`- **Snapshot of the discarded changes:** git stash \`${entry.snapshot.ref}\` ("${entry.snapshot.message}") — ` +
				`restore with \`git stash apply ${entry.snapshot.ref}\``,
		);
	}
	const logs = (entry.logFiles ?? []).filter((file) => file.trim());
	if (logs.length > 0) {
		out.push("- **Subagent logs:**");
		for (const file of logs) out.push(`  - \`${file}\``);
	}
	if (entry.summary?.trim()) out.push(listItem(`**Summary:** ${entry.summary}`, ""));
	const errors = (entry.errors ?? []).filter((error) => error.trim());
	if (errors.length > 0) {
		out.push("- **Errors:**");
		for (const error of errors) out.push(listItem(error, "  "));
	}
	return out.join("\n");
}

/**
 * Append an attempt to the `## Failed Attempts` section of a todo body. The
 * section is created at the end of the body if it does not exist; otherwise
 * the entry is added at the end of the existing section.
 */
export function appendAttempt(body: string, entry: AttemptEntry): string {
	const block = buildAttemptEntry(entry);
	const lines = body.trimEnd().split("\n");
	const start = lines.findIndex((line) => line.trim() === FAILED_ATTEMPTS_HEADING);
	if (start === -1) {
		const base = body.trimEnd();
		return `${base ? `${base}\n\n` : ""}${FAILED_ATTEMPTS_HEADING}\n\n${block}`;
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	const head = lines.slice(0, end).join("\n").trimEnd();
	const tail = lines.slice(end).join("\n");
	return `${head}\n\n${block}${tail ? `\n\n${tail}` : ""}`;
}
