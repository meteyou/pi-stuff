import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	PAUSE_MAX_LISTED_ERRORS,
	RELEASE_LABEL,
	buildPauseMenu,
	buildPauseTitle,
	pauseActionLabel,
	pauseActions,
	releaseReasonFor,
	skipSummaryFor,
} from "./pause.ts";
import type { PauseAction, PausePhase, PauseReasonKind } from "./pause.ts";

const PHASES: PausePhase[] = ["Implement", "Review", "Fix", "Commit"];

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pause.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("pauseActions", () => {
	it("offers all options for a manual pause in implement/review/fix", () => {
		for (const phase of ["Implement", "Review", "Fix"] as PausePhase[]) {
			assert.deepEqual(pauseActions("manual", phase), [
				"resume",
				"skip-phase",
				"retry-task",
				"release",
				"skip-task",
				"abort",
			]);
		}
	});

	it("never offers skip phase during commit", () => {
		const reasons: PauseReasonKind[] = [
			"manual",
			"implementation-failed",
			"invalid-result",
			"phase-failed",
			"committer-failed",
			"hook-failed",
			"round-limit",
		];
		for (const reason of reasons) {
			assert.equal(pauseActions(reason, "Commit").includes("skip-phase"), false, reason);
		}
		assert.deepEqual(pauseActions("manual", "Commit"), ["resume", "retry-task", "release", "skip-task", "abort"]);
	});

	it("offers retry task, release, skip task, abort when the implementation failed after all retries", () => {
		assert.deepEqual(pauseActions("implementation-failed", "Implement"), ["retry-task", "release", "skip-task", "abort"]);
	});

	it("offers retry phase, release, skip task, abort when JSON repair failed", () => {
		for (const phase of PHASES) {
			assert.deepEqual(pauseActions("invalid-result", phase), ["retry-phase", "release", "skip-task", "abort"]);
		}
	});

	it("offers retry phase for committer and hook failures", () => {
		assert.deepEqual(pauseActions("committer-failed", "Commit"), ["retry-phase", "release", "skip-task", "abort"]);
		assert.deepEqual(pauseActions("hook-failed", "Commit"), ["retry-phase", "release", "skip-task", "abort"]);
	});

	it("keeps the round-limit options", () => {
		assert.deepEqual(pauseActions("round-limit", "Review"), [
			"one-more-round",
			"commit-as-is",
			"release",
			"skip-task",
			"abort",
		]);
	});
});

describe("pauseActionLabel", () => {
	it("labels the manual pause options as specified", () => {
		assert.match(pauseActionLabel("resume", "Review"), /^🟢 Resume current phase/);
		assert.match(pauseActionLabel("skip-phase", "Fix"), /Skip phase/);
		assert.match(pauseActionLabel("retry-task", "Fix"), /Retry task — discard changes \(except \.pi\/\), restart at implement/);
		assert.equal(pauseActionLabel("release", "Implement"), RELEASE_LABEL);
		assert.match(pauseActionLabel("skip-task", "Implement"), /Skip task — discard changes \(except \.pi\/\)/);
		assert.match(pauseActionLabel("abort", "Implement"), /Abort/);
	});

	it("names the phase agent for retry phase", () => {
		assert.match(pauseActionLabel("retry-phase", "Review"), /run the reviewer again/);
		assert.match(pauseActionLabel("retry-phase", "Commit"), /run the committer again/);
	});

	it("has a distinct label for every action within a menu", () => {
		const reasons: PauseReasonKind[] = ["manual", "implementation-failed", "invalid-result", "round-limit"];
		for (const reason of reasons) {
			for (const phase of PHASES) {
				const labels = pauseActions(reason, phase).map((a: PauseAction) => pauseActionLabel(a, phase));
				assert.equal(new Set(labels).size, labels.length, `${reason}/${phase}`);
			}
		}
	});
});

describe("buildPauseTitle", () => {
	it("shows task, phase and reason", () => {
		const title = buildPauseTitle({ taskLabel: "Task 2/5: Settings", phase: "Review", phaseLabel: "Review 2/3", reason: "manual" });
		assert.equal(title, ["⏸️  Paused — Task 2/5: Settings", "Phase: Review 2/3", "Reason: manual pause (Ctrl+C)"].join("\n"));
	});

	it("falls back to the phase name and the default reason text", () => {
		const title = buildPauseTitle({ taskLabel: "Task 1/5: X", phase: "Commit", reason: "invalid-result" });
		assert.match(title, /^Phase: Commit$/m);
		assert.match(title, /^Reason: JSON repair failed — the committer returned no valid result$/m);
	});

	it("lists errors (capped and truncated) and details", () => {
		const errors = Array.from({ length: PAUSE_MAX_LISTED_ERRORS + 2 }, (_, i) => `error ${i}\nsecond line`);
		errors[0] = "x".repeat(1000);
		const title = buildPauseTitle({
			taskLabel: "Task 1/5: X",
			phase: "Implement",
			reason: "implementation-failed",
			reasonText: "implementation failed after 2 attempts",
			errors,
			details: ["2 open findings:", "  [P1] a.ts:1 — A"],
		});
		assert.match(title, /^Reason: implementation failed after 2 attempts$/m);
		assert.match(title, /^Errors:$/m);
		assert.match(title, /^ {2}• error 1 second line$/m);
		assert.match(title, /^ {2}… and 2 more$/m);
		assert.doesNotMatch(title, /x{400}/);
		assert.match(title, /^ {2}\[P1\] a\.ts:1 — A$/m);
	});
});

describe("buildPauseMenu", () => {
	it("resumes when a manual pause menu is cancelled", () => {
		const menu = buildPauseMenu({ taskLabel: "T", phase: "Fix", reason: "manual" });
		assert.equal(menu.cancelAction, "resume");
		assert.deepEqual(menu.options.map((o) => o.action), pauseActions("manual", "Fix"));
	});

	it("shows failure menus again when cancelled", () => {
		for (const reason of ["implementation-failed", "invalid-result", "hook-failed", "round-limit"] as PauseReasonKind[]) {
			assert.equal(buildPauseMenu({ taskLabel: "T", phase: "Commit", reason }).cancelAction, undefined);
		}
	});
});

describe("releaseReasonFor / skipSummaryFor", () => {
	it("describes manual pauses by phase", () => {
		assert.equal(releaseReasonFor({ phase: "Review", reason: "manual" }), "manual pause during review");
		assert.equal(skipSummaryFor({ phase: "Fix", reason: "manual" }), "Skipped after a manual pause during fix.");
	});

	it("uses the reason text for other pauses", () => {
		assert.equal(releaseReasonFor({ phase: "Commit", reason: "hook-failed" }), "git hook failed");
		assert.equal(
			releaseReasonFor({ phase: "Implement", reason: "implementation-failed", reasonText: "implementation failed after 3 attempts" }),
			"implementation failed after 3 attempts",
		);
		assert.equal(skipSummaryFor({ phase: "Commit", reason: "committer-failed" }), "Skipped after the loop paused: committer failed.");
	});
});
