import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	COMMIT_AS_IS_REASON,
	MISSING_FIX_RESULT_REASON,
	applyFixOutcomes,
	applyReview,
	commitAsIs,
	createReviewCycle,
	cycleCounts,
	extendRoundLimit,
	fixOutcomesFromResult,
	meetsFixThreshold,
	nextStep,
	openFindings,
	rejectedForNextReview,
	reportFields,
	splitFindings,
} from "./review-cycle.ts";
import type { CycleStep, FixOutcome, ReviewCycleState } from "./review-cycle.ts";
import type { FindingPriority, ReviewerResult, ReviewFinding } from "./subagent-result.ts";

const f = (priority: FindingPriority, title: string): ReviewFinding => ({
	priority,
	title,
	file: `src/${title.toLowerCase().replace(/\s+/g, "-")}.ts`,
	line: 1,
	body: `Body of ${title}.`,
});

const review = (findings: ReviewFinding[], callouts: string[] = []): ReviewerResult => ({
	verdict: findings.length > 0 ? "needs attention" : "correct",
	summary: `${findings.length} finding(s)`,
	findings,
	callouts,
});

const fixed = (summary = "Fixed."): FixOutcome => ({ status: "fixed", summary, verification: "npm test" });
const rejected = (reason = "False positive."): FixOutcome => ({ status: "rejected", reason });
const unresolved = (reason = "Fixer crashed"): FixOutcome => ({ status: "unresolved", reason });

/** Compact step description for table assertions. */
function describeStep(step: CycleStep): string {
	switch (step.kind) {
		case "review":
			return `review ${step.round}/${step.roundLimit}`;
		case "fix":
			return `fix ${step.round}: ${step.findings.map((x) => `[${x.priority}] ${x.title}`).join(", ")}`;
		case "commit":
			return "commit";
		case "pause":
			return `pause ${step.reason} ${step.round}/${step.roundLimit}: ${step.openFindings.map((x) => `[${x.priority}] ${x.title}`).join(", ")}`;
	}
}

type Event =
	| { review: ReviewerResult }
	| { fix: FixOutcome[] }
	| { extend: true }
	| { commitAsIs: true };

/** Apply events in order and collect the step reported before each event plus the final step. */
function run(state: ReviewCycleState, events: Event[]): { steps: string[]; state: ReviewCycleState } {
	const steps: string[] = [];
	let current = state;
	for (const event of events) {
		steps.push(describeStep(nextStep(current)));
		if ("review" in event) current = applyReview(current, event.review);
		else if ("fix" in event) current = applyFixOutcomes(current, event.fix);
		else if ("extend" in event) current = extendRoundLimit(current);
		else current = commitAsIs(current);
	}
	steps.push(describeStep(nextStep(current)));
	return { steps, state: current };
}

const cycle = (fixThreshold: FindingPriority = "P1", maxReviewRounds = 3) => createReviewCycle({ fixThreshold, maxReviewRounds });

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "review-cycle.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
		assert.doesNotMatch(source, /from\s+["']@mariozechner\//);
	});
});

describe("meetsFixThreshold / splitFindings", () => {
	const table: Array<[FindingPriority, FindingPriority, boolean]> = [
		["P0", "P0", true],
		["P1", "P0", false],
		["P1", "P1", true],
		["P2", "P1", false],
		["P2", "P2", true],
		["P3", "P2", false],
		["P3", "P3", true],
		["P0", "P3", true],
	];
	for (const [priority, threshold, expected] of table) {
		it(`${priority} vs threshold ${threshold} → ${expected}`, () => {
			assert.equal(meetsFixThreshold(priority, threshold), expected);
		});
	}

	it("sorts actionable findings P0 → P3 (stable) and keeps deferred in input order", () => {
		const input = [f("P2", "a"), f("P1", "b"), f("P3", "c"), f("P0", "d"), f("P1", "e")];
		const { actionable, deferred } = splitFindings(input, "P2");
		assert.deepEqual(actionable.map((x) => x.title), ["d", "b", "e", "a"]);
		assert.deepEqual(deferred.map((x) => x.title), ["c"]);
	});
});

describe("createReviewCycle", () => {
	it("rejects invalid options", () => {
		assert.throws(() => createReviewCycle({ fixThreshold: "P4" as FindingPriority, maxReviewRounds: 3 }));
		assert.throws(() => createReviewCycle({ fixThreshold: "P1", maxReviewRounds: 0 }));
		assert.throws(() => createReviewCycle({ fixThreshold: "P1", maxReviewRounds: 1.5 }));
	});

	it("starts with review round 1", () => {
		assert.equal(describeStep(nextStep(cycle())), "review 1/3");
	});
});

describe("nextStep transitions (table-driven)", () => {
	const cases: Array<{
		name: string;
		threshold?: FindingPriority;
		maxRounds?: number;
		events: Event[];
		steps: string[];
		counts?: Partial<ReturnType<typeof cycleCounts>>;
	}> = [
		{
			name: "no findings → commit",
			events: [{ review: review([]) }],
			steps: ["review 1/3", "commit"],
			counts: { round: 1, fixed: 0, rejected: 0, deferred: 0, unresolved: 0 },
		},
		{
			name: "only findings below threshold → commit, recorded as deferred",
			threshold: "P1",
			events: [{ review: review([f("P2", "Style"), f("P3", "Naming")]) }],
			steps: ["review 1/3", "commit"],
			counts: { deferred: 2, fixed: 0 },
		},
		{
			name: "mixed findings → fix only ≥ threshold in priority order, then re-review",
			threshold: "P1",
			events: [
				{ review: review([f("P2", "Style"), f("P1", "Edge case"), f("P0", "Crash"), f("P3", "Nit")]) },
				{ fix: [fixed(), fixed()] },
				{ review: review([]) },
			],
			steps: ["review 1/3", "fix 1: [P0] Crash, [P1] Edge case", "review 2/3", "commit"],
			counts: { round: 2, fixed: 2, deferred: 2 },
		},
		{
			name: "all rejected → commit without re-review",
			events: [
				{ review: review([f("P1", "A"), f("P0", "B")]) },
				{ fix: [rejected("Intended behavior."), rejected("Covered by caller.")] },
			],
			steps: ["review 1/3", "fix 1: [P0] B, [P1] A", "commit"],
			counts: { round: 1, fixed: 0, rejected: 2 },
		},
		{
			name: "some fixed, some rejected → re-review",
			events: [
				{ review: review([f("P1", "A"), f("P1", "B")]) },
				{ fix: [rejected(), fixed()] },
			],
			steps: ["review 1/3", "fix 1: [P1] A, [P1] B", "review 2/3"],
			counts: { fixed: 1, rejected: 1 },
		},
		{
			name: "unresolved only (no fixer result) → commit, finding reported as unresolved",
			events: [{ review: review([f("P0", "A")]) }, { fix: [unresolved()] }],
			steps: ["review 1/3", "fix 1: [P0] A", "commit"],
			counts: { fixed: 0, unresolved: 1 },
		},
		{
			name: "unresolved + fixed → re-review; superseded unresolved is dropped",
			events: [
				{ review: review([f("P0", "A"), f("P1", "B")]) },
				{ fix: [unresolved(), fixed()] },
				{ review: review([]) },
			],
			steps: ["review 1/3", "fix 1: [P0] A, [P1] B", "review 2/3", "commit"],
			counts: { round: 2, fixed: 1, unresolved: 0 },
		},
		{
			name: "round limit with open findings → pause (no fixing in the last round)",
			maxRounds: 2,
			events: [
				{ review: review([f("P1", "A")]) },
				{ fix: [fixed()] },
				{ review: review([f("P1", "A again"), f("P0", "New")]) },
			],
			steps: ["review 1/2", "fix 1: [P1] A", "review 2/2", "pause round-limit 2/2: [P0] New, [P1] A again"],
			counts: { round: 2, fixed: 1 },
		},
		{
			name: "round limit reached but only findings below threshold → commit",
			maxRounds: 1,
			events: [{ review: review([f("P3", "Nit")]) }],
			steps: ["review 1/1", "commit"],
			counts: { deferred: 1 },
		},
		{
			name: "pause → one more round → fix + re-review",
			maxRounds: 1,
			events: [
				{ review: review([f("P1", "A")]) },
				{ extend: true },
				{ fix: [fixed()] },
				{ review: review([]) },
			],
			steps: ["review 1/1", "pause round-limit 1/1: [P1] A", "fix 1: [P1] A", "review 2/2", "commit"],
			counts: { round: 2, roundLimit: 2, fixed: 1 },
		},
		{
			name: "pause → commit as-is → open findings unresolved",
			maxRounds: 1,
			events: [{ review: review([f("P1", "A"), f("P0", "B")]) }, { commitAsIs: true }],
			steps: ["review 1/1", "pause round-limit 1/1: [P0] B, [P1] A", "commit"],
			counts: { unresolved: 2, fixed: 0 },
		},
		{
			name: "threshold P0 defers P1–P3",
			threshold: "P0",
			events: [{ review: review([f("P1", "A"), f("P2", "B"), f("P3", "C")]) }],
			steps: ["review 1/3", "commit"],
			counts: { deferred: 3 },
		},
		{
			name: "threshold P3 fixes everything",
			threshold: "P3",
			events: [{ review: review([f("P3", "C"), f("P2", "B")]) }, { fix: [fixed(), rejected()] }],
			steps: ["review 1/3", "fix 1: [P2] B, [P3] C", "review 2/3"],
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			const { steps, state } = run(cycle(testCase.threshold, testCase.maxRounds), testCase.events);
			assert.deepEqual(steps, testCase.steps);
			if (testCase.counts) {
				const counts = cycleCounts(state);
				for (const [key, value] of Object.entries(testCase.counts)) {
					assert.equal(counts[key as keyof typeof counts], value, `count ${key}`);
				}
			}
		});
	}
});

describe("guards", () => {
	it("applyReview throws when no review is due", () => {
		const state = applyReview(cycle(), review([f("P1", "A")]));
		assert.throws(() => applyReview(state, review([])), /next step is "fix"/);
	});

	it("applyFixOutcome throws when no fix is due", () => {
		assert.throws(() => applyFixOutcomes(cycle(), [fixed()]), /next step is "review"/);
	});

	it("applyFixOutcomes throws when the number of outcomes differs from the findings", () => {
		const state = applyReview(cycle(), review([f("P1", "A"), f("P0", "B")]));
		assert.throws(() => applyFixOutcomes(state, [fixed()]), /Expected 2 fix outcome\(s\), got 1/);
		assert.throws(() => applyFixOutcomes(state, [fixed(), fixed(), fixed()]), /Expected 2 fix outcome\(s\), got 3/);
	});

	it("does not mutate the given state", () => {
		const initial = cycle();
		const snapshot = JSON.stringify(initial);
		const reviewed = applyReview(initial, review([f("P1", "A"), f("P3", "B")], ["New dependency"]));
		const reviewedSnapshot = JSON.stringify(reviewed);
		applyFixOutcomes(reviewed, [rejected()]);
		extendRoundLimit(reviewed);
		commitAsIs(reviewed);
		assert.equal(JSON.stringify(initial), snapshot);
		assert.equal(JSON.stringify(reviewed), reviewedSnapshot);
	});
});

describe("rejected findings for the next review prompt", () => {
	it("accumulates rejected findings with reasons across rounds", () => {
		const { state } = run(cycle(), [
			{ review: review([f("P1", "A"), f("P1", "B")]) },
			{ fix: [rejected("A is intended."), fixed()] },
			{ review: review([f("P0", "C"), f("P1", "D")]) },
			{ fix: [rejected("C is handled upstream."), fixed()] },
		]);
		const list = rejectedForNextReview(state);
		assert.deepEqual(
			list.map((item) => [item.finding.title, item.reason, item.round]),
			[
				["A", "A is intended.", 1],
				["C", "C is handled upstream.", 2],
			],
		);
		assert.equal(describeStep(nextStep(state)), "review 3/3");
	});

	it("fills in a placeholder for empty reasons", () => {
		const { state } = run(cycle(), [{ review: review([f("P1", "A")]) }, { fix: [rejected("  ")] }]);
		assert.equal(state.rejected[0]!.reason, "(no reason given)");
	});
});

describe("openFindings / reportFields", () => {
	it("lists the unprocessed findings of the last round", () => {
		const state = applyReview(cycle("P1", 1), review([f("P1", "A"), f("P0", "B")]));
		assert.deepEqual(openFindings(state).map((x) => x.title), ["B", "A"]);
	});

	it("builds the report fields (rounds, verdict, fixed, rejected, deferred, unresolved, callouts)", () => {
		const { state } = run(cycle("P1", 2), [
			{ review: review([f("P0", "A"), f("P1", "B"), f("P2", "Style")], ["New dependency: x"]) },
			{ fix: [fixed("Guarded null."), rejected("Intended.")] },
			{ review: review([f("P1", "C"), f("P2", "Style"), f("P3", "Nit")], ["Auth change"]) },
			{ commitAsIs: true },
		]);
		const fields = reportFields(state);
		assert.equal(fields.reviewRounds, 2);
		assert.equal(fields.finalVerdict, "needs attention");
		assert.equal(fields.reviewSummary, "3 finding(s)");
		assert.deepEqual(fields.fixed.map((x) => [x.finding.title, x.summary, x.round]), [["A", "Guarded null.", 1]]);
		assert.deepEqual(fields.rejected.map((x) => [x.finding.title, x.reason, x.round]), [["B", "Intended.", 1]]);
		// "Style" is raised in both rounds but recorded once
		assert.deepEqual(fields.deferred.map((x) => x.title), ["Style", "Nit"]);
		assert.deepEqual(fields.unresolved.map((x) => [x.finding.title, x.reason, x.round]), [["C", COMMIT_AS_IS_REASON, 2]]);
		assert.deepEqual(fields.callouts, ["New dependency: x", "Auth change"]);
	});

	it("reports unresolved findings without a fixer result", () => {
		const { state } = run(cycle(), [{ review: review([f("P0", "A")]) }, { fix: [unresolved(MISSING_FIX_RESULT_REASON)] }]);
		assert.deepEqual(reportFields(state).unresolved.map((x) => [x.finding.title, x.reason]), [["A", MISSING_FIX_RESULT_REASON]]);
	});

	it("is empty before the first review", () => {
		const fields = reportFields(cycle());
		assert.equal(fields.reviewRounds, 0);
		assert.equal(fields.finalVerdict, undefined);
		assert.deepEqual([fields.fixed, fields.rejected, fields.deferred, fields.unresolved, fields.callouts], [[], [], [], [], []]);
	});
});

describe("fixOutcomesFromResult", () => {
	it("maps one outcome per finding by 1-based id and attaches the shared verification to fixed findings", () => {
		const outcomes = fixOutcomesFromResult(3, {
			results: [
				{ id: 2, status: "rejected", reason: "Intended.", summary: "Checked callers." },
				{ id: 1, status: "fixed", reason: "Was missing.", summary: "Added a guard." },
				{ id: 3, status: "fixed", reason: "Off by one.", summary: "" },
			],
			verification: "npm test (ok)",
		});
		assert.deepEqual(outcomes, [
			{ status: "fixed", summary: "Added a guard. — Verification: npm test (ok)", verification: "npm test (ok)" },
			{ status: "rejected", reason: "Intended.", summary: "Checked callers." },
			{ status: "fixed", summary: "Off by one. — Verification: npm test (ok)", verification: "npm test (ok)" },
		]);
	});

	it("marks findings without a result as unresolved and ignores unknown or duplicate ids", () => {
		const outcomes = fixOutcomesFromResult(2, {
			results: [
				{ id: 2, status: "fixed", reason: "", summary: "First." },
				{ id: 2, status: "rejected", reason: "Duplicate.", summary: "" },
				{ id: 7, status: "fixed", reason: "", summary: "Unknown id." },
			],
			verification: "",
		});
		assert.deepEqual(outcomes, [
			{ status: "unresolved", reason: MISSING_FIX_RESULT_REASON },
			{ status: "fixed", summary: "First.", verification: undefined },
		]);
	});

	it("falls back to the summary for rejected findings without a reason", () => {
		const [outcome] = fixOutcomesFromResult(1, { results: [{ id: 1, status: "rejected", reason: " ", summary: "Not reproducible." }], verification: "" });
		assert.deepEqual(outcome, { status: "rejected", reason: "Not reproducible.", summary: "Not reproducible." });
	});

	it("feeds the cycle: fixed + rejected + unresolved in one batch", () => {
		const state = applyReview(cycle(), review([f("P1", "A"), f("P0", "B"), f("P1", "C")]));
		const step = nextStep(state);
		assert.equal(step.kind, "fix");
		if (step.kind !== "fix") return;
		const outcomes = fixOutcomesFromResult(step.findings.length, {
			results: [
				{ id: 1, status: "fixed", reason: "", summary: "Fixed B." },
				{ id: 2, status: "rejected", reason: "A is intended.", summary: "" },
			],
			verification: "npm test",
		});
		const next = applyFixOutcomes(state, outcomes);
		assert.deepEqual(next.fixed.map((x) => x.finding.title), ["B"]);
		assert.deepEqual(next.rejected.map((x) => [x.finding.title, x.reason]), [["A", "A is intended."]]);
		assert.deepEqual(reportFields(next).unresolved.map((x) => x.finding.title), ["C"]);
		assert.equal(describeStep(nextStep(next)), "review 2/3");
	});
});
