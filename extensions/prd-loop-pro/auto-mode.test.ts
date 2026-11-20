import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	AUTO_MAX_DECISIONS_PER_TASK,
	autoAttemptActionText,
	autoCandidateActions,
	buildDeciderPrompt,
	canAutoSplit,
	createAutoTaskState,
	isAutoDecidable,
	validateDecision,
} from "./auto-mode.ts";
import type { AutoTaskState, DeciderPromptInput } from "./auto-mode.ts";
import type { PauseAction } from "./pause.ts";
import { DECIDER_RESULT_SCHEMA, validateResult } from "./subagent-result.ts";

function stateWith(...actions: PauseAction[]): AutoTaskState {
	return { decisions: actions.map((action) => ({ reason: "r", action, rationale: "" })) };
}

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "auto-mode.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("isAutoDecidable", () => {
	it("decides blocked tasks, failed implementations and the round limit only", () => {
		assert.equal(isAutoDecidable("task-blocked"), true);
		assert.equal(isAutoDecidable("implementation-failed"), true);
		assert.equal(isAutoDecidable("round-limit"), true);
		for (const reason of ["manual", "invalid-result", "phase-failed", "committer-failed", "hook-failed"] as const) {
			assert.equal(isAutoDecidable(reason), false, reason);
		}
	});
});

describe("autoCandidateActions", () => {
	const base = { phase: "Implement" as const, sequenceLabel: "17/20", state: createAutoTaskState() };

	it("never offers abort, skip task, resume or skip phase", () => {
		for (const reason of ["task-blocked", "implementation-failed"] as const) {
			const actions = autoCandidateActions({ ...base, reason });
			for (const excluded of ["abort", "skip-task", "resume", "skip-phase"] as const) {
				assert.equal(actions.includes(excluded), false, `${reason}: ${excluded}`);
			}
		}
		assert.deepEqual(autoCandidateActions({ ...base, reason: "task-blocked" }), ["split-task", "release", "retry-phase", "retry-task"]);
		assert.deepEqual(autoCandidateActions({ ...base, phase: "Review", reason: "round-limit" }), ["one-more-round", "commit-as-is", "release"]);
	});

	it("returns nothing for pauses that are not decidable", () => {
		assert.deepEqual(autoCandidateActions({ ...base, reason: "manual" }), []);
		assert.deepEqual(autoCandidateActions({ ...base, phase: "Commit", reason: "hook-failed" }), []);
	});

	it("limits repeated actions per task", () => {
		const actions = autoCandidateActions({ ...base, reason: "implementation-failed", state: stateWith("retry-phase", "retry-task") });
		assert.deepEqual(actions, ["split-task", "release"]);
		const round = autoCandidateActions({ ...base, phase: "Review", reason: "round-limit", state: stateWith("one-more-round") });
		assert.deepEqual(round, ["commit-as-is", "release"]);
	});

	it("leaves the decision to the human once the budget is used up or only release is left", () => {
		const full = stateWith(...Array.from({ length: AUTO_MAX_DECISIONS_PER_TASK }, () => "release" as const));
		assert.deepEqual(autoCandidateActions({ ...base, reason: "task-blocked", state: full }), []);
		const onlyRelease = autoCandidateActions({
			...base,
			sequenceLabel: "17a1/20",
			reason: "task-blocked",
			state: stateWith("retry-phase", "retry-task"),
		});
		assert.deepEqual(onlyRelease, []);
	});

	it("splits only within the depth limit", () => {
		assert.equal(canAutoSplit("17/20"), true);
		assert.equal(canAutoSplit("17a/20"), true);
		assert.equal(canAutoSplit("17a1/20"), false);
		assert.equal(canAutoSplit("?/?"), false);
		assert.equal(autoCandidateActions({ ...base, sequenceLabel: "17a1/20", reason: "task-blocked" }).includes("split-task"), false);
		assert.equal(autoCandidateActions({ ...base, reason: "task-blocked", state: stateWith("split-task") }).includes("split-task"), false);
	});
});

describe("validateDecision", () => {
	it("accepts an offered action and normalizes it", () => {
		assert.deepEqual(validateDecision({ action: " `Split-Task` ", rationale: "too\nlarge" }, ["split-task", "release"]), {
			ok: true,
			action: "split-task",
			rationale: "too large",
		});
	});

	it("rejects an action that is not offered", () => {
		const result = validateDecision({ action: "skip-task", rationale: "" }, ["split-task", "release"]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /not one of the offered actions/);
	});

	it("decider schema requires an action", () => {
		assert.equal(validateResult(DECIDER_RESULT_SCHEMA, { rationale: "x" }).ok, false);
		assert.deepEqual(validateResult(DECIDER_RESULT_SCHEMA, { action: "release" }), { ok: true, value: { action: "release", rationale: "" } });
	});
});

describe("buildDeciderPrompt", () => {
	const input: DeciderPromptInput = {
		taskTitle: "PRD #1 - Task 17/20: Port the renderer",
		taskBody: "## What to build\n\nPort it.",
		prdId: "TODO-abc123",
		phase: "Implement",
		phaseLabel: "Implement",
		reason: "task-blocked",
		reasonText: "the implementer reported that the task cannot be completed as written: 90 functions",
		errors: ["boom"],
		details: ["Split proposed by the implementer:", "  1. Allocator"],
		summary: "Ported 10 of 90 functions.",
		blockedReason: "90 functions",
		proposedSplit: [{ title: "Allocator", description: "6 functions" }],
		candidates: ["split-task", "release"],
		previousDecisions: [{ reason: "implementation failed", action: "retry-phase", rationale: "small errors" }],
		hasChanges: true,
	};

	it("lists the reason, the proposal, earlier decisions, the offered actions and the task", () => {
		const prompt = buildDeciderPrompt(input);
		assert.match(prompt, /Reason: the implementer reported/);
		assert.match(prompt, /- Errors:\n {2}- boom/);
		assert.match(prompt, /1\. Allocator — 6 functions/);
		assert.match(prompt, /implementation failed → `retry-phase` — small errors/);
		assert.match(prompt, /- `split-task` — /);
		assert.match(prompt, /- `release` — /);
		assert.doesNotMatch(prompt, /`retry-task`/);
		assert.match(prompt, /git diff HEAD/);
		assert.match(prompt, /## The task\n\n## What to build/);
		assert.match(prompt, /\.pi\/todos\/abc123\.md/);
		// The blocked details repeat the proposal and are not listed twice.
		assert.doesNotMatch(prompt, /Split proposed by the implementer/);
	});

	it("includes the open findings of a round-limit pause", () => {
		const prompt = buildDeciderPrompt({
			...input,
			phase: "Review",
			phaseLabel: "Review 3/3 — round limit",
			reason: "round-limit",
			reasonText: "review round limit reached (3/3) with 1 open finding",
			details: ["Open findings:", "  • P1 src/a.ts:3 — Off by one"],
			blockedReason: undefined,
			proposedSplit: undefined,
			candidates: ["one-more-round", "commit-as-is", "release"],
			previousDecisions: [],
			hasChanges: false,
		});
		assert.match(prompt, /P1 src\/a\.ts:3 — Off by one/);
		assert.match(prompt, /- `commit-as-is` — .*never with an open P0/);
		assert.doesNotMatch(prompt, /Earlier automatic decisions/);
		assert.match(prompt, /no uncommitted changes/);
	});
});

describe("autoAttemptActionText", () => {
	it("marks the action as chosen by auto mode", () => {
		assert.equal(
			autoAttemptActionText("split-task", "too large"),
			"Split into subtasks (changes discarded) — chosen by auto mode: too large",
		);
		assert.equal(autoAttemptActionText("release", ""), "Released / handed over to a human (changes kept on disk) — chosen by auto mode");
	});
});
