import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ATTEMPT_MAX_TEXT_LENGTH,
	FAILED_ATTEMPTS_HEADING,
	appendAttempt,
	attemptActionText,
	buildAttemptEntry,
	shouldRecordAttempt,
} from "./attempt-log.ts";
import type { AttemptEntry } from "./attempt-log.ts";
import type { PauseAction, PauseReasonKind } from "./pause.ts";

const entry = (overrides: Partial<AttemptEntry> = {}): AttemptEntry => ({
	timestamp: "2026-11-13 23:30",
	phase: "Implement",
	reason: "implementation failed after 2 attempts",
	action: "Retry task (changes discarded, restarted at implement)",
	...overrides,
});

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "attempt-log.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("shouldRecordAttempt", () => {
	it("records every failure pause, whatever the action", () => {
		const reasons: PauseReasonKind[] = ["implementation-failed", "task-blocked", "invalid-result", "phase-failed", "committer-failed", "hook-failed"];
		for (const reason of reasons) {
			for (const action of ["retry-phase", "retry-task", "release", "abort"] as PauseAction[]) {
				assert.equal(shouldRecordAttempt(reason, action), true, `${reason}/${action}`);
			}
		}
	});

	it("records manual and round-limit pauses only when they end the attempt", () => {
		for (const reason of ["manual", "round-limit"] as PauseReasonKind[]) {
			for (const action of ["resume", "skip-phase", "one-more-round", "commit-as-is"] as PauseAction[]) {
				assert.equal(shouldRecordAttempt(reason, action), false, `${reason}/${action}`);
			}
			for (const action of ["retry-task", "skip-task", "split-task", "release", "abort"] as PauseAction[]) {
				assert.equal(shouldRecordAttempt(reason, action), true, `${reason}/${action}`);
			}
		}
	});
});

describe("buildAttemptEntry", () => {
	it("lists action, snapshot, logs, summary and errors", () => {
		const text = buildAttemptEntry(entry({
			errors: ["cargo test failed\n  left: 1\n  right: 2", " "],
			summary: "Ported 40 of 160 functions.",
			snapshot: { ref: "abc123", message: "prd-loop-pro: Task 17a/20 — retry task" },
			logFiles: ["/logs/001-17a-20-implement.jsonl"],
		}));
		assert.equal(text, [
			"### 2026-11-13 23:30 — Implement: implementation failed after 2 attempts",
			"",
			"- **Action:** Retry task (changes discarded, restarted at implement)",
			'- **Snapshot of the discarded changes:** git stash `abc123` ("prd-loop-pro: Task 17a/20 — retry task") — restore with `git stash apply abc123`',
			"- **Subagent logs:**",
			"  - `/logs/001-17a-20-implement.jsonl`",
			"- **Summary:** Ported 40 of 160 functions.",
			"- **Errors:**",
			"  - cargo test failed",
			// Continuation lines keep their own indentation inside the list item.
			"      left: 1",
			"      right: 2",
		].join("\n"));
	});

	it("omits empty parts and truncates long texts", () => {
		const text = buildAttemptEntry(entry({ errors: ["x".repeat(ATTEMPT_MAX_TEXT_LENGTH + 500)] }));
		assert.doesNotMatch(text, /Snapshot|Subagent logs|Summary/);
		assert.ok(text.length < ATTEMPT_MAX_TEXT_LENGTH + 300);
		assert.match(text, /…$/);
	});

	it("has a text for every action", () => {
		const actions: PauseAction[] = ["resume", "skip-phase", "retry-phase", "retry-task", "one-more-round", "commit-as-is", "split-task", "release", "skip-task", "abort"];
		for (const action of actions) assert.ok(attemptActionText(action).length > 0, action);
	});
});

describe("appendAttempt", () => {
	it("creates the section at the end of the body", () => {
		const body = appendAttempt("## What to build\n\nX\n", entry());
		assert.match(body, new RegExp(`^## What to build\\n\\nX\\n\\n${FAILED_ATTEMPTS_HEADING}\\n\\n### 2026-11-13 23:30 — `));
	});

	it("appends to an existing section and keeps the sections after it", () => {
		const first = appendAttempt("## What to build\n\nX", entry());
		const withReport = `${first}\n\n## Execution Report\n\n- done`;
		const second = appendAttempt(withReport, entry({ timestamp: "2026-11-14 09:00", reason: "git hook failed" }));
		assert.equal(second.match(new RegExp(FAILED_ATTEMPTS_HEADING, "g"))!.length, 1);
		assert.ok(second.indexOf("2026-11-13 23:30") < second.indexOf("2026-11-14 09:00"));
		assert.ok(second.indexOf("2026-11-14 09:00") < second.indexOf("## Execution Report"));
		assert.match(second, /## Execution Report\n\n- done$/);
	});

	it("works on an empty body", () => {
		assert.match(appendAttempt("", entry()), new RegExp(`^${FAILED_ATTEMPTS_HEADING}\\n\\n### `));
	});
});
