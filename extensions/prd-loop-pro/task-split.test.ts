import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	addSplitToPrdIndex,
	appendToSection,
	describeSplitProposal,
	getSection,
	planSplit,
	replaceSection,
	validateSplitProposal,
} from "./task-split.ts";
import type { SplitInput } from "./task-split.ts";
import type { SplitProposal } from "./subagent-result.ts";
import { SPLITTER_RESULT_SCHEMA, WORKER_RESULT_SCHEMA, validateResult } from "./subagent-result.ts";
import { parseBlockedBy, resolveTaskOrder, syncPrdTaskIndex } from "./task-index.ts";
import type { TaskInfo } from "./task-index.ts";
import { parseSequenceLabel } from "./task-sequence.ts";

const PARENT_BODY = [
	"## Parent PRD",
	"",
	"TODO-d6d75bc1 (PRD #1: Foundation)",
	"",
	"## What to build",
	"",
	"Port 160 functions.",
	"",
	"### Rules",
	"",
	"- Size limit: 60 functions",
	"",
	"## Acceptance criteria",
	"",
	"- [ ] all ported",
	"- [ ] viewer works",
	"",
	"## Blocked by",
	"",
	"- TODO-aaaa0001 (PRD #1 - Task 16/20: Models)",
	"",
	"## Next task",
	"",
	"- TODO-bbbb0001 (PRD #1 - Task 17b/20: Start-up)",
	"",
	"## User stories addressed",
	"",
	"- User story 3",
].join("\n");

const proposal = (overrides: Partial<SplitProposal> = {}): SplitProposal => ({
	rationale: "Three independent classes.",
	subtasks: [
		{ title: "Allocator", whatToBuild: "Port the allocator (6 functions).", acceptanceCriteria: ["vectors match"], dependsOn: [] },
		{ title: "Surfaces", whatToBuild: "Port the surfaces.", acceptanceCriteria: ["- [ ] surfaces match", "tests pass"], dependsOn: [1] },
		{ title: "Error log", whatToBuild: "Port the log.", acceptanceCriteria: ["log matches"], dependsOn: [1] },
	],
	parent: { whatToBuild: "Wire the viewer to the ported parts.", acceptanceCriteria: ["viewer works"] },
	...overrides,
});

const input = (overrides: Partial<SplitInput> = {}): SplitInput => ({
	parent: { id: "TODO-6f93b98b", title: "PRD #1 - Task 17a/20: Engine allocator and surfaces", body: PARENT_BODY, sequenceLabel: "17a/20" },
	existingLabels: ["16/20", "17/20", "17a/20", "17b/20"],
	proposal: proposal(),
	newIds: ["TODO-00000001", "TODO-00000002", "TODO-00000003"],
	date: "2026-11-14",
	reason: "implementation failed after 2 attempts",
	...overrides,
});

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "task-split.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("section helpers", () => {
	it("reads a section up to the next h2 (h3 stays inside)", () => {
		assert.equal(getSection(PARENT_BODY, "## What to build"), "Port 160 functions.\n\n### Rules\n\n- Size limit: 60 functions");
		assert.equal(getSection(PARENT_BODY, "## User stories addressed"), "- User story 3");
		assert.equal(getSection(PARENT_BODY, "## Missing"), undefined);
	});

	it("replaces a section in place and appends a missing one", () => {
		const replaced = replaceSection(PARENT_BODY, "## Blocked by", "- TODO-x");
		assert.equal(getSection(replaced, "## Blocked by"), "- TODO-x");
		assert.equal(getSection(replaced, "## Next task"), "- TODO-bbbb0001 (PRD #1 - Task 17b/20: Start-up)");
		assert.equal(getSection(replaced, "## Acceptance criteria"), "- [ ] all ported\n- [ ] viewer works");
		const appended = replaceSection(PARENT_BODY, "## History", "- a");
		assert.match(appended, /- User story 3\n\n## History\n\n- a$/);
		assert.equal(getSection(appendToSection(appended, "## History", "- b"), "## History"), "- a\n- b");
	});
});

describe("validateSplitProposal", () => {
	it("accepts a usable proposal", () => {
		assert.deepEqual(validateSplitProposal(proposal()), []);
	});

	it("reports too few subtasks, forward dependencies and missing parts", () => {
		const one = proposal({ subtasks: [proposal().subtasks[0]!] });
		assert.match(validateSplitProposal(one).join("\n"), /at least 2 subtasks, got 1/);

		const bad = proposal();
		bad.subtasks[0]!.dependsOn = [2];
		bad.subtasks[1]!.dependsOn = [2];
		bad.subtasks[2]!.title = " ";
		bad.subtasks[2]!.acceptanceCriteria = [];
		bad.parent.whatToBuild = "";
		const issues = validateSplitProposal(bad).join("\n");
		assert.match(issues, /subtask 1 depends on 2/);
		assert.match(issues, /subtask 2 depends on 2/);
		assert.match(issues, /subtask 3 has no title/);
		assert.match(issues, /subtask 3 has no acceptance criteria/);
		assert.match(issues, /remaining scope of the original task/);
	});
});

describe("planSplit", () => {
	it("labels subtasks hierarchically and keeps the title prefix and total", () => {
		const plan = planSplit(input());
		assert.deepEqual(plan.subtasks.map((s) => s.title), [
			"PRD #1 - Task 17a1/20: Allocator",
			"PRD #1 - Task 17a2/20: Surfaces",
			"PRD #1 - Task 17a3/20: Error log",
		]);
		assert.deepEqual(plan.subtasks.map((s) => s.sequenceLabel), ["17a1/20", "17a2/20", "17a3/20"]);
		for (const subtask of plan.subtasks) assert.equal(parseSequenceLabel(subtask.title), subtask.sequenceLabel);
	});

	it("continues after existing subtasks", () => {
		const plan = planSplit(input({ existingLabels: ["17a/20", "17a1/20", "17a4/20"] }));
		assert.deepEqual(plan.subtasks.map((s) => s.sequenceLabel), ["17a5/20", "17a6/20", "17a7/20"]);
	});

	it("gives independent subtasks the parent's blockers and the others their dependencies", () => {
		const plan = planSplit(input());
		assert.deepEqual(parseBlockedBy(plan.subtasks[0]!.body), ["TODO-aaaa0001"]);
		assert.deepEqual(parseBlockedBy(plan.subtasks[1]!.body), ["TODO-00000001"]);
		assert.deepEqual(parseBlockedBy(plan.subtasks[2]!.body), ["TODO-00000001"]);
		assert.deepEqual(plan.subtasks.map((s) => s.blockedBy), [[], ["TODO-00000001"], ["TODO-00000001"]]);

		const unblocked = planSplit(input({ parent: { ...input().parent, body: replaceSection(PARENT_BODY, "## Blocked by", "None — can start immediately") } }));
		assert.deepEqual(parseBlockedBy(unblocked.subtasks[0]!.body), []);
	});

	it("writes complete subtask bodies", () => {
		const body = planSplit(input()).subtasks[1]!.body;
		assert.match(getSection(body, "## Parent PRD")!, /^TODO-d6d75bc1 \(PRD #1: Foundation\)\n\nSplit from TODO-6f93b98b \(PRD #1 - Task 17a\/20: Engine allocator and surfaces\) on 2026-11-14 by \/prd-loop-pro: implementation failed after 2 attempts\. Three independent classes\.$/);
		assert.equal(getSection(body, "## What to build"), "Port the surfaces.");
		assert.equal(getSection(body, "## Acceptance criteria"), "- [ ] surfaces match\n- [ ] tests pass");
		assert.equal(getSection(body, "## Next task"), "- TODO-6f93b98b (PRD #1 - Task 17a/20: Engine allocator and surfaces)");
		assert.equal(getSection(body, "## User stories addressed"), "- User story 3");
		assert.equal(getSection(body, "## Earlier attempt"), undefined);
		// The first subtask points at the subtasks that depend on it.
		assert.equal(
			getSection(planSplit(input()).subtasks[0]!.body, "## Next task"),
			"- TODO-00000002 (PRD #1 - Task 17a2/20: Surfaces)\n- TODO-00000003 (PRD #1 - Task 17a3/20: Error log)",
		);
	});

	it("references the snapshot of the failed attempt", () => {
		const plan = planSplit(input({ snapshot: { ref: "abc123", message: "prd-loop-pro: Task 17a/20 — split" } }));
		const section = getSection(plan.subtasks[0]!.body, "## Earlier attempt")!;
		assert.match(section, /git stash \(`abc123`, "prd-loop-pro: Task 17a\/20 — split"\)/);
		assert.match(section, /git stash show --include-untracked -p abc123/);
		assert.match(getSection(plan.parentBody, "## History")!, /git stash `abc123`/);
	});

	it("turns the parent into the close-out task blocked by the last subtasks", () => {
		const plan = planSplit(input());
		assert.deepEqual(plan.parentBlockedBy, ["TODO-00000002", "TODO-00000003"]);
		assert.deepEqual(parseBlockedBy(plan.parentBody), ["TODO-00000002", "TODO-00000003"]);
		assert.match(getSection(plan.parentBody, "## What to build")!, /^Wire the viewer to the ported parts\.\n\nThis is the close-out of a split: .*subtasks 17a1–17a3 \(TODO-00000001, TODO-00000002, TODO-00000003\)/);
		assert.equal(getSection(plan.parentBody, "## Acceptance criteria"), "- [ ] viewer works");
		assert.equal(getSection(plan.parentBody, "## Next task"), "- TODO-bbbb0001 (PRD #1 - Task 17b/20: Start-up)");
		assert.match(getSection(plan.parentBody, "## History")!, /^- 2026-11-14: split into 17a1–17a3 by \/prd-loop-pro \(implementation failed after 2 attempts\)\. Three independent classes\.$/);
	});

	it("yields a resolvable task graph: subtasks first, then the parent, then its dependents", () => {
		const plan = planSplit(input());
		const task = (id: string, title: string, body: string, status = "open"): TaskInfo => ({
			id, title, status, body, blockedBy: parseBlockedBy(body), sequenceLabel: parseSequenceLabel(title),
		});
		const tasks = [
			task("TODO-bbbb0001", "PRD #1 - Task 17b/20: Start-up", "## Blocked by\n\n- TODO-6f93b98b (x)"),
			task("TODO-6f93b98b", input().parent.title, plan.parentBody),
			...plan.subtasks.map((s) => task(s.id, s.title, s.body)),
			task("TODO-aaaa0001", "PRD #1 - Task 16/20: Models", "", "closed"),
		];
		const resolution = resolveTaskOrder(tasks);
		assert.equal(resolution.error, undefined);
		assert.deepEqual(resolution.actionable.map((t) => t.id), ["TODO-00000001", "TODO-00000002", "TODO-00000003", "TODO-6f93b98b", "TODO-bbbb0001"]);
	});

	it("rejects unusable input", () => {
		assert.throws(() => planSplit(input({ proposal: proposal({ subtasks: [] }) })), /Invalid split proposal/);
		assert.throws(() => planSplit(input({ newIds: ["TODO-00000001"] })), /One todo id per subtask/);
		assert.throws(() => planSplit(input({ parent: { ...input().parent, title: "No label", sequenceLabel: "?/?" } })), /has no sequence label/);
	});
});

describe("addSplitToPrdIndex", () => {
	const PRD = [
		"## Task Index",
		"",
		"| # | Task | Todo | Blocked by | Status |",
		"|---|------|------|------------|--------|",
		"| 16/20 | Models | TODO-aaaa0001 | — | ✅ done |",
		"| 17a/20 | Engine allocator and surfaces | TODO-6f93b98b | TODO-aaaa0001 | 🔓 ready |",
		"| 17b/20 | Start-up | TODO-bbbb0001 | TODO-6f93b98b | ⏳ blocked |",
		"",
		"Next up: **TODO-6f93b98b** (x)",
	].join("\n");

	it("adds the subtask rows below the parent row and updates the parent's blockers", () => {
		const plan = planSplit(input());
		const result = addSplitToPrdIndex(PRD, "TODO-6f93b98b", plan);
		assert.equal(result.updated, true);
		const lines = result.body.split("\n");
		assert.deepEqual(lines.slice(5, 10), [
			"| 17a/20 | Engine allocator and surfaces | TODO-6f93b98b | TODO-00000002, TODO-00000003 | 🔓 ready |",
			"| 17a1/20 | Allocator | TODO-00000001 | — | ⏳ blocked |",
			"| 17a2/20 | Surfaces | TODO-00000002 | TODO-00000001 | ⏳ blocked |",
			"| 17a3/20 | Error log | TODO-00000003 | TODO-00000001 | ⏳ blocked |",
			"| 17b/20 | Start-up | TODO-bbbb0001 | TODO-6f93b98b | ⏳ blocked |",
		]);
	});

	it("produces an index the status sync understands", () => {
		const plan = planSplit(input());
		const body = addSplitToPrdIndex(PRD, "TODO-6f93b98b", plan).body;
		const task = (id: string, title: string, taskBody: string, status = "open"): TaskInfo => ({
			id, title, status, body: taskBody, blockedBy: parseBlockedBy(taskBody), sequenceLabel: parseSequenceLabel(title),
		});
		const synced = syncPrdTaskIndex(body, [
			task("TODO-aaaa0001", "PRD #1 - Task 16/20: Models", "", "closed"),
			task("TODO-6f93b98b", input().parent.title, plan.parentBody),
			...plan.subtasks.map((s) => task(s.id, s.title, s.body)),
			task("TODO-bbbb0001", "PRD #1 - Task 17b/20: Start-up", "## Blocked by\n\n- TODO-6f93b98b (x)"),
		]);
		assert.match(synced, /\| 17a\/20 \| .* \| ⏳ blocked \|/);
		assert.match(synced, /\| 17a1\/20 \| Allocator \| TODO-00000001 \| — \| 🔓 ready \|/);
		assert.match(synced, /\| 17a2\/20 \| .* \| ⏳ blocked \|/);
		assert.match(synced, /^Next up: \*\*TODO-00000001\*\* \(PRD #1 - Task 17a1\/20: Allocator\)$/m);
	});

	it("follows a different column order", () => {
		const prd = [
			"| Todo | # | Status | Task |",
			"|---|---|---|---|",
			"| TODO-6f93b98b | 17a/20 | 🔓 ready | Engine |",
		].join("\n");
		const lines = addSplitToPrdIndex(prd, "TODO-6f93b98b", planSplit(input())).body.split("\n");
		assert.equal(lines[2], "| TODO-6f93b98b | 17a/20 | 🔓 ready | Engine |");
		assert.equal(lines[3], "| TODO-00000001 | 17a1/20 | ⏳ blocked | Allocator |");
	});

	it("leaves the body unchanged when the parent has no row", () => {
		const result = addSplitToPrdIndex("No index here.", "TODO-6f93b98b", planSplit(input()));
		assert.deepEqual(result, { body: "No index here.", updated: false });
	});
});

describe("describeSplitProposal", () => {
	it("lists the subtasks with their dependencies and the close-out", () => {
		assert.deepEqual(describeSplitProposal(proposal(), ["17a1/20", "17a2/20", "17a3/20"]), [
			"Three independent classes.",
			"",
			"  17a1: Allocator — 1 acceptance criterion",
			"  17a2: Surfaces (after 17a1) — 2 acceptance criteria",
			"  17a3: Error log (after 17a1) — 1 acceptance criterion",
			"",
			"  Close-out (original task): Wire the viewer to the ported parts.",
		]);
	});
});

describe("result schemas", () => {
	it("accepts a splitter result and applies defaults", () => {
		const result = validateResult(SPLITTER_RESULT_SCHEMA, {
			subtasks: [{ title: "A", whatToBuild: "a", acceptanceCriteria: ["x"] }],
			parent: { whatToBuild: "p", acceptanceCriteria: [] },
		});
		assert.ok(result.ok);
		assert.equal(result.value.rationale, "");
		assert.deepEqual(result.value.subtasks[0]!.dependsOn, []);
	});

	it("rejects a splitter result without the close-out", () => {
		const result = validateResult(SPLITTER_RESULT_SCHEMA, { subtasks: [] });
		assert.equal(result.ok, false);
	});

	it("accepts a worker result with and without blocked", () => {
		const plain = validateResult(WORKER_RESULT_SCHEMA, { success: true });
		assert.ok(plain.ok);
		assert.equal(plain.value.blocked, undefined);

		const blocked = validateResult(WORKER_RESULT_SCHEMA, {
			success: false,
			summary: "too large",
			blocked: { reason: "160 functions", proposedSplit: [{ title: "Allocator" }] },
		});
		assert.ok(blocked.ok);
		assert.deepEqual(blocked.value.blocked, { reason: "160 functions", proposedSplit: [{ title: "Allocator", description: "" }] });

		const noSplit = validateResult(WORKER_RESULT_SCHEMA, { success: false, blocked: { reason: "missing decision" } });
		assert.ok(noSplit.ok);
		assert.deepEqual(noSplit.value.blocked!.proposedSplit, []);

		assert.ok(validateResult(WORKER_RESULT_SCHEMA, { success: false, blocked: null }).ok);
	});
});
