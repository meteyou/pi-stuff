import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	INDEX_STATUS_LABELS,
	NEEDS_HUMAN_STATUS,
	checkGitClean,
	isNeedsHuman,
	isTaskClosed,
	parseBlockedBy,
	resolveTaskOrder,
	syncPrdTaskIndex,
} from "./task-index.ts";
import type { TaskInfo } from "./task-index.ts";

const task = (n: number, status: string, blockedBy: number[] = []): TaskInfo => ({
	id: `TODO-${n}0`,
	title: `PRD #1 - Task ${n}/5: Task ${n}`,
	status,
	body: "",
	blockedBy: blockedBy.map((b) => `TODO-${b}0`),
	sequenceLabel: `${n}/5`,
});

const ids = (tasks: TaskInfo[]) => tasks.map((t) => t.id);

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "task-index.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("status helpers", () => {
	it("treats needs-human as neither closed nor open-actionable", () => {
		assert.equal(isTaskClosed("closed"), true);
		assert.equal(isTaskClosed("done"), true);
		assert.equal(isTaskClosed(NEEDS_HUMAN_STATUS), false);
		assert.equal(isNeedsHuman("needs-human"), true);
		assert.equal(isNeedsHuman("open"), false);
	});

	it("parses blockers", () => {
		assert.deepEqual(parseBlockedBy("## Blocked by\n\n- TODO-ab12 (x)\n- TODO-cd34 (y)\n\n## Next"), ["TODO-ab12", "TODO-cd34"]);
		assert.deepEqual(parseBlockedBy("## Blocked by\n\nNone — can start immediately\n"), []);
	});
});

describe("resolveTaskOrder", () => {
	it("orders open tasks topologically and skips closed ones", () => {
		const result = resolveTaskOrder([task(1, "closed"), task(2, "open", [1]), task(3, "open", [2])]);
		assert.deepEqual(ids(result.actionable), ["TODO-20", "TODO-30"]);
		assert.deepEqual(result.held, []);
	});

	it("holds back needs-human tasks and their transitive dependents", () => {
		const tasks = [
			task(1, "closed"),
			task(2, NEEDS_HUMAN_STATUS, [1]),
			task(3, "open", [2]),
			task(4, "open", [3]),
			task(5, "open", [1]),
		];
		const result = resolveTaskOrder(tasks);
		assert.equal(result.error, undefined);
		assert.deepEqual(ids(result.actionable), ["TODO-50"]);
		assert.deepEqual(ids(result.held), ["TODO-20", "TODO-30", "TODO-40"]);
	});

	it("returns no actionable tasks when everything open is held", () => {
		const result = resolveTaskOrder([task(1, NEEDS_HUMAN_STATUS), task(2, "open", [1])]);
		assert.deepEqual(result.actionable, []);
		assert.deepEqual(ids(result.held), ["TODO-10", "TODO-20"]);
	});

	it("treats the needs-human task being resolved as actionable and runs it first", () => {
		const tasks = [
			task(1, "open"),
			task(2, NEEDS_HUMAN_STATUS),
			task(3, "open", [2]),
			task(4, NEEDS_HUMAN_STATUS),
			task(5, "open", [4]),
		];
		const result = resolveTaskOrder(tasks, { resolvingTaskId: "TODO-20" });
		assert.deepEqual(ids(result.actionable), ["TODO-20", "TODO-10", "TODO-30"]);
		assert.deepEqual(ids(result.held), ["TODO-40", "TODO-50"]);
	});

	it("still detects circular dependencies", () => {
		const result = resolveTaskOrder([task(1, "open", [2]), task(2, "open", [1])]);
		assert.match(result.error ?? "", /Circular dependency/);
		assert.deepEqual(result.actionable, []);
	});
});

describe("syncPrdTaskIndex", () => {
	const body = [
		"## Task Index",
		"",
		"| # | Task | Todo | Blocked by | Status |",
		"|---|------|------|------------|--------|",
		"| 1/5 | One | TODO-10 | — | 🔄 open |",
		"| 2/5 | Two | TODO-20 | TODO-10 | ⏳ blocked |",
		"| 3/5 | Three | TODO-30 | TODO-20 | ⏳ blocked |",
		"| 4/5 | Four | TODO-40 | TODO-10 | ⏳ blocked |",
		"",
		"Next up: **TODO-10** (One)",
	].join("\n");

	it("shows needs-human distinctly and keeps its dependents blocked", () => {
		const synced = syncPrdTaskIndex(body, [
			task(1, "closed"),
			task(2, NEEDS_HUMAN_STATUS, [1]),
			task(3, "open", [2]),
			task(4, "open", [1]),
		]);
		const lines = synced.split("\n");
		assert.match(lines[4]!, new RegExp(`\\| ${INDEX_STATUS_LABELS.closed} \\|$`));
		assert.match(lines[5]!, new RegExp(`\\| ${INDEX_STATUS_LABELS.needsHuman} \\|$`));
		assert.match(lines[6]!, new RegExp(`\\| ${INDEX_STATUS_LABELS.blocked} \\|$`));
		assert.match(lines[7]!, new RegExp(`\\| ${INDEX_STATUS_LABELS.ready} \\|$`));
		assert.equal(lines[9], "Next up: **TODO-40** (PRD #1 - Task 4/5: Task 4)");
	});

	it("points to the needs-human task when nothing else is actionable", () => {
		const synced = syncPrdTaskIndex(body, [
			task(1, "closed"),
			task(2, NEEDS_HUMAN_STATUS, [1]),
			task(3, "open", [2]),
			task(4, "closed", [1]),
		]);
		assert.match(synced.split("\n")[9]!, /^Next up: \*\*TODO-20\*\* .*needs-human/);
	});

	it("marks all done when every task is closed", () => {
		const synced = syncPrdTaskIndex(body, [task(1, "closed"), task(2, "done"), task(3, "closed"), task(4, "closed")]);
		assert.equal(synced.split("\n")[9], "Next up: All tasks completed! 🎉");
		assert.equal(synced.split("\n").filter((line) => line.includes(INDEX_STATUS_LABELS.closed)).length, 4);
	});
});

describe("checkGitClean", () => {
	it("passes a clean working tree", () => {
		assert.deepEqual(checkGitClean("", false), { ok: true, dirty: false });
		assert.deepEqual(checkGitClean("\n", true), { ok: true, dirty: false });
	});

	it("allows uncommitted changes only while resolving a needs-human task", () => {
		const porcelain = " M src/app.ts\n?? src/new.ts\n";
		assert.deepEqual(checkGitClean(porcelain, true), { ok: true, dirty: true });
		const failed = checkGitClean(porcelain, false);
		assert.equal(failed.ok, false);
		assert.match(failed.ok ? "" : failed.error, /Uncommitted changes detected/);
	});
});
