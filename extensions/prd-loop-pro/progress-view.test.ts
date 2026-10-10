import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	appendOutputEvent,
	appendPhaseEvent,
	buildOutcomeLabel,
	buildSummaryEntryLines,
	buildSummaryLines,
	buildSummaryTaskLine,
	buildTaskDetailLines,
	countPhaseEvents,
	finishPhaseGroup,
	fixPhaseLabel,
	formatFixOutcomes,
	formatPhaseCosts,
	formatReviewOutcome,
	phaseGroupMeta,
	phaseHeader,
	startPhaseGroup,
} from "./progress-view.ts";
import type { OutputEvent, PhaseOutputGroup, SummaryInput, TaskReviewProgress } from "./progress-view.ts";

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "progress-view.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("appendOutputEvent", () => {
	it("records tools and collapses consecutive text/thinking deltas", () => {
		const events: OutputEvent[] = [];
		appendOutputEvent(events, { type: "thinking", turn: 1 }, 1);
		appendOutputEvent(events, { type: "thinking", turn: 1 }, 2);
		appendOutputEvent(events, { type: "tool_start", toolName: "bash", argsSummary: "ls", turn: 1 }, 3);
		appendOutputEvent(events, { type: "tool_end", toolName: "bash", toolSuccess: false, resultPreview: "x", turn: 1 }, 4);
		appendOutputEvent(events, { type: "text_delta", text: "a", turn: 2 }, 5);
		appendOutputEvent(events, { type: "text_delta", text: "b", turn: 2 }, 6);
		assert.deepEqual(
			events.map((e) => e.kind),
			["thinking", "tool_start", "tool_end", "text"],
		);
		assert.equal(events[2]!.error, true);
		assert.equal(events[1]!.args, "ls");
	});
});

describe("phaseHeader", () => {
	it("formats implement, review, fix and commit headers", () => {
		assert.equal(phaseHeader({ phase: "implement" }), "Implement");
		assert.equal(phaseHeader({ phase: "implement", attempt: 1 }), "Implement");
		assert.equal(phaseHeader({ phase: "implement", attempt: 2 }), "Implement (attempt 2)");
		assert.equal(phaseHeader({ phase: "review", round: 1 }), "Review #1");
		assert.equal(phaseHeader({ phase: "fix", round: 1, count: 3 }), "Fix #1 • 3 findings");
		assert.equal(phaseHeader({ phase: "fix", round: 2, count: 1 }, "retry"), "Fix #2 • 1 finding (retry)");
		assert.equal(fixPhaseLabel(2, 4), "Fix #2 • 4 findings");
		assert.equal(phaseHeader({ phase: "commit" }), "Commit");
	});

	it("appends notes, combined with the attempt", () => {
		assert.equal(phaseHeader({ phase: "review", round: 2 }, "retry"), "Review #2 (retry)");
		assert.equal(phaseHeader({ phase: "implement", attempt: 3 }, "resumed"), "Implement (attempt 3, resumed)");
		assert.equal(phaseHeader({ phase: "commit" }, "  "), "Commit");
	});
});

describe("phase groups", () => {
	it("groups events under the latest phase and closes the previous group", () => {
		const groups: PhaseOutputGroup[] = [];
		startPhaseGroup(groups, { phase: "implement" }, { now: 0 });
		appendPhaseEvent(groups, { type: "tool_start", toolName: "read", turn: 1 }, 10);
		startPhaseGroup(groups, { phase: "review", round: 1 }, { now: 100 });
		appendPhaseEvent(groups, { type: "thinking", turn: 1 }, 110);
		appendPhaseEvent(groups, { type: "tool_start", toolName: "bash", turn: 1 }, 120);

		assert.deepEqual(groups.map((g) => g.header), ["Implement", "Review #1"]);
		assert.equal(groups[0]!.endTime, 100);
		assert.equal(groups[0]!.events.length, 1);
		assert.equal(groups[1]!.events.length, 2);
		assert.equal(groups[1]!.endTime, undefined);
		assert.equal(countPhaseEvents(groups), 3);
	});

	it("creates a fallback group for activity without a phase", () => {
		const groups: PhaseOutputGroup[] = [];
		appendPhaseEvent(groups, { type: "tool_start", toolName: "ls", turn: 1 }, 5);
		assert.equal(groups.length, 1);
		assert.equal(groups[0]!.header, "Output");
	});

	it("records cost (accumulated) and outcome, and renders the meta text", () => {
		const groups: PhaseOutputGroup[] = [];
		startPhaseGroup(groups, { phase: "fix", round: 1, count: 1 }, { now: 0 });
		assert.equal(phaseGroupMeta(groups[0]!, 5_000), "running… • 0:05");

		finishPhaseGroup(groups, { cost: 0.1 }, 61_000);
		finishPhaseGroup(groups, { cost: 0.05, outcome: "rejected —\n false positive", failed: false }, 90_000);
		const group = groups[0]!;
		assert.equal(group.endTime, 61_000);
		assert.ok(Math.abs(group.cost! - 0.15) < 1e-9);
		assert.equal(group.outcome, "rejected — false positive");
		assert.equal(phaseGroupMeta(group, 999_999), "rejected — false positive • $0.15 • 1:01");
	});

	it("finishPhaseGroup is a no-op without groups", () => {
		const groups: PhaseOutputGroup[] = [];
		finishPhaseGroup(groups, { outcome: "x" });
		assert.equal(groups.length, 0);
	});
});

describe("outcome texts", () => {
	it("formats review outcomes with priority breakdown", () => {
		assert.equal(formatReviewOutcome("correct", []), "correct • no findings");
		assert.equal(
			formatReviewOutcome("needs attention", [{ priority: "P3" }, { priority: "P1" }, { priority: "P3" }]),
			"needs attention • 3 findings (1×P1, 2×P3)",
		);
		assert.equal(formatReviewOutcome("needs attention", [{ priority: "P0" }]), "needs attention • 1 finding (1×P0)");
	});

	it("formats batch fix outcomes (zero counts omitted)", () => {
		assert.equal(
			formatFixOutcomes([
				{ status: "fixed", summary: "a" },
				{ status: "rejected", reason: "b" },
				{ status: "fixed", summary: "c" },
				{ status: "unresolved", reason: "d" },
			]),
			"2 fixed, 1 rejected, 1 unresolved",
		);
		assert.equal(formatFixOutcomes([{ status: "rejected", reason: "x" }]), "1 rejected");
		assert.equal(formatFixOutcomes([]), "no findings");
	});
});

const REVIEW: TaskReviewProgress = {
	round: 2,
	roundLimit: 3,
	fixed: 2,
	rejected: 1,
	deferred: 3,
	unresolved: 0,
	verdict: "needs attention",
	callouts: 1,
};

describe("task details", () => {
	it("formats cost per phase, omitting phases without cost", () => {
		assert.equal(formatPhaseCosts({}), "$0.00");
		assert.equal(
			formatPhaseCosts({ implement: 0.2, review: 0.15, fix: 0.1, commit: 0 }),
			"$0.45 — implement $0.20 • review $0.15 • fix $0.10",
		);
	});

	it("shows round counter, counts and cost per phase", () => {
		const lines = buildTaskDetailLines({ review: REVIEW, phaseCosts: { implement: 0.2, review: 0.05 } });
		assert.deepEqual(lines, [
			{ label: "Rounds", text: "2/3 • needs attention • 1 callout" },
			{ label: "Findings", text: "2 fixed • 1 rejected • 3 deferred • 0 unresolved" },
			{ label: "Cost", text: "$0.25 — implement $0.20 • review $0.05" },
		]);
	});

	it("shows the review note and omits empty sections", () => {
		assert.deepEqual(buildTaskDetailLines({}), []);
		assert.deepEqual(buildTaskDetailLines({ reviewNote: "No changes outside .pi/ — review skipped.", phaseCosts: {} }), [
			{ label: "Review", text: "No changes outside .pi/ — review skipped." },
		]);
		const noVerdict = buildTaskDetailLines({ review: { ...REVIEW, verdict: undefined, callouts: 0 } });
		assert.equal(noVerdict[0]!.text, "2/3");
	});
});

describe("summary", () => {
	it("shows per-task rounds and counts", () => {
		const line = buildSummaryTaskLine({
			label: "Task 3/11: Review Phase",
			status: "completed",
			elapsedMs: 151_000,
			cost: 0.45,
			retries: 1,
			review: REVIEW,
		});
		assert.equal(line, "Task 3/11: Review Phase  ✅  2:31  $0.45  1 retry  2 rounds: 2 fixed, 1 rejected, 3 deferred, 0 unresolved");
		assert.doesNotMatch(line, /⚠️/);
	});

	it("marks needs-human tasks with ⚠️", () => {
		const line = buildSummaryTaskLine({
			label: "Task 4/11: Fix Cycle",
			status: "needs-human",
			elapsedMs: 60_000,
			cost: 0,
			retries: 0,
			review: { ...REVIEW, round: 3, unresolved: 2 },
		});
		assert.ok(line.startsWith("⚠️ Task 4/11: Fix Cycle  🔧"));
		assert.match(line, /3 rounds: 2 fixed, 1 rejected, 3 deferred, 2 unresolved/);
		assert.ok(line.endsWith("⚠️ needs-human"));
	});

	it("shows the review note when no review ran", () => {
		const line = buildSummaryTaskLine({
			label: "Task 1/2: A",
			status: "completed",
			cost: 0,
			retries: 0,
			reviewNote: "Review skipped manually",
		});
		assert.equal(line, "Task 1/2: A  ✅  Review skipped manually");
	});

	it("builds headline, task rows and totals", () => {
		const input: SummaryInput = {
			prdTitle: "PRD #1",
			outcome: "released",
			tasks: [
				{ label: "Task 1/3: A", status: "completed", elapsedMs: 10_000, cost: 0.5, retries: 0, review: { ...REVIEW, round: 1 } },
				{ label: "Task 2/3: B", status: "needs-human", elapsedMs: 20_000, cost: 0.25, retries: 2, review: REVIEW },
				{ label: "Task 3/3: C", status: "pending", cost: 0, retries: 0 },
			],
			totalElapsedMs: 30_000,
			totalCost: 0.75,
			totalCommits: 2,
		};
		const lines = buildSummaryLines(input);
		assert.equal(lines[0], "🔧 PRD #1 — Loop stopped — task released to a human (needs-human)");
		assert.equal(lines[1], "");
		assert.equal(lines.length, 2 + 3 + 2);
		assert.ok(lines[3]!.startsWith("⚠️ Task 2/3: B"));
		assert.equal(lines[4], "Task 3/3: C  ⏳");
		assert.equal(
			lines.at(-1),
			"Total: 0:30 | $0.75 | 2 retries | 2 commits | 3 review rounds | 4 fixed, 2 rejected, 6 deferred, 0 unresolved | ⚠️ 1 needs-human",
		);
	});

	it("omits review totals and needs-human count when not applicable", () => {
		const lines = buildSummaryLines({
			prdTitle: "P",
			outcome: "completed",
			tasks: [{ label: "Task 1/1: A", status: "completed", cost: 0, retries: 0 }],
			totalElapsedMs: 0,
			totalCost: 0,
			totalCommits: 1,
		});
		assert.equal(lines[0], "✅ P — Loop completed");
		assert.equal(lines.at(-1), "Total: 0:00 | $0.00 | 0 retries | 1 commit");
	});
});

describe("summary entry", () => {
	const input: SummaryInput = {
		prdTitle: "PRD #1",
		outcome: "released",
		tasks: [
			{ label: "Task 1/4: A", status: "completed", elapsedMs: 10_000, cost: 0.5, retries: 0 },
			{ label: "Task 2/4: B", status: "needs-human", elapsedMs: 20_000, cost: 0.25, retries: 0 },
			{ label: "Task 3/4: C", status: "failed", cost: 0, retries: 0 },
			{ label: "Task 4/4: D", status: "pending", cost: 0, retries: 0 },
		],
		totalElapsedMs: 30_000,
		totalCost: 0.75,
		totalCommits: 1,
	};

	it("shows every task when expanded, without a hint", () => {
		const lines = buildSummaryEntryLines(input, true);
		assert.deepEqual(lines.map((l) => l.kind), ["headline", "blank", "task", "task", "task", "task", "blank", "totals"]);
		assert.equal(lines[0]!.text, "🔧 PRD #1 — Loop stopped — task released to a human (needs-human)");
		assert.equal(lines[2]!.status, "completed");
		assert.ok(lines.at(-1)!.text.startsWith("Total: 0:30 | $0.75"));
	});

	it("shows only tasks that need attention when collapsed, plus an expand hint", () => {
		const lines = buildSummaryEntryLines(input, false, "ctrl+x");
		assert.deepEqual(lines.map((l) => l.kind), ["headline", "blank", "task", "task", "blank", "totals", "hint"]);
		assert.deepEqual(lines.filter((l) => l.kind === "task").map((l) => l.status), ["needs-human", "failed"]);
		assert.equal(lines.at(-1)!.text, "2 more tasks — ctrl+x to expand");
	});

	it("omits the task block when collapsed and nothing needs attention", () => {
		const lines = buildSummaryEntryLines(
			{ ...input, outcome: "completed", tasks: [{ label: "Task 1/1: A", status: "completed", cost: 0, retries: 0 }] },
			false,
		);
		assert.deepEqual(lines.map((l) => l.kind), ["headline", "blank", "totals", "hint"]);
		assert.equal(lines.at(-1)!.text, "1 more task — ctrl+o to expand");
	});

	it("formats the outcome label without the PRD title", () => {
		assert.equal(buildOutcomeLabel("completed"), "✅ Loop completed");
		assert.equal(buildOutcomeLabel("failed"), "❌ Loop failed");
	});
});
