import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	UNKNOWN_SEQUENCE_LABEL,
	compareSequenceLabels,
	extractShortTitle,
	isSubtaskOf,
	parseSequenceLabel,
	sequenceDepth,
	sequenceSegments,
	sortBySequence,
	subtaskProgress,
} from "./task-sequence.ts";

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "task-sequence.ts"), "utf8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works/);
	});
});

describe("parseSequenceLabel / extractShortTitle", () => {
	it("parses plain and split labels", () => {
		assert.equal(parseSequenceLabel("PRD #1 - Task 2/8: Foo"), "2/8");
		assert.equal(parseSequenceLabel("PRD #1 - Task 17a/20: Foo"), "17a/20");
		assert.equal(parseSequenceLabel("PRD #1 - Task 17a1/20: Foo"), "17a1/20");
		assert.equal(parseSequenceLabel("PRD #1 - Task 17A12b/20: Foo"), "17a12b/20");
		assert.equal(parseSequenceLabel("Something else"), UNKNOWN_SEQUENCE_LABEL);
	});

	it("strips the prefix of plain and split titles", () => {
		assert.equal(extractShortTitle("PRD #1 - Task 2/8: Foo bar"), "Foo bar");
		assert.equal(extractShortTitle("PRD #1 - Task 17a1/20: Runtime memory"), "Runtime memory");
		assert.equal(extractShortTitle("No label"), "No label");
	});
});

describe("segments / depth / subtask relation", () => {
	it("splits into alternating number and letter segments", () => {
		assert.deepEqual(sequenceSegments("17a1/20"), ["17", "a", "1"]);
		assert.deepEqual(sequenceSegments("?/?"), []);
		assert.equal(sequenceDepth("17/20"), 0);
		assert.equal(sequenceDepth("17a/20"), 1);
		assert.equal(sequenceDepth("17a1/20"), 2);
		assert.equal(sequenceDepth("?/?"), 0);
	});

	it("detects transitive subtasks only on segment boundaries", () => {
		assert.ok(isSubtaskOf("17a1/20", "17/20"));
		assert.ok(isSubtaskOf("17a1/20", "17a/20"));
		assert.ok(!isSubtaskOf("17/20", "17/20"));
		assert.ok(!isSubtaskOf("17a/20", "1/20"));
		assert.ok(!isSubtaskOf("17a10/20", "17a1/20"));
		assert.ok(!isSubtaskOf("17b/20", "17a/20"));
	});
});

describe("compareSequenceLabels / sortBySequence", () => {
	it("orders hierarchically with subtasks after their parent", () => {
		const labels = ["18/20", "17a10/20", "17b/20", "?/?", "17a2/20", "2/20", "17/20", "17a1/20", "16/20", "17a/20", "10/20"];
		assert.deepEqual([...labels].sort(compareSequenceLabels), [
			"2/20", "10/20", "16/20", "17/20", "17a/20", "17a1/20", "17a2/20", "17a10/20", "17b/20", "18/20", "?/?",
		]);
	});

	it("sorts tasks by label, then title", () => {
		const t = (sequenceLabel: string, title: string) => ({ sequenceLabel, title });
		const sorted = sortBySequence([t("17a1/20", "x"), t("?/?", "b"), t("17/20", "y"), t("?/?", "a"), t("16/20", "z")]);
		assert.deepEqual(sorted.map((s) => `${s.sequenceLabel} ${s.title}`), ["16/20 z", "17/20 y", "17a1/20 x", "?/? a", "?/? b"]);
	});
});

describe("subtaskProgress", () => {
	const t = (sequenceLabel: string, done: boolean) => ({ sequenceLabel, done });
	const tasks = [t("17/20", false), t("17a1/20", true), t("17a2/20", false), t("17b/20", true), t("18/20", false)];

	it("counts transitive subtasks", () => {
		assert.deepEqual(subtaskProgress(tasks[0]!, tasks, (x) => x.done), { done: 2, total: 3 });
	});

	it("is undefined for tasks that were not split", () => {
		assert.equal(subtaskProgress(tasks[4]!, tasks, (x) => x.done), undefined);
	});
});
