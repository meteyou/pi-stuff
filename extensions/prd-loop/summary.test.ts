import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildOutcomeLabel,
	buildSummaryEntryLines,
	buildSummaryTaskLine,
	buildSummaryTotalsLine,
	formatElapsed,
} from "./summary.ts";
import type { SummaryInput } from "./summary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(HERE, "summary.ts"), "utf8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("summary lines", () => {
	it("formats elapsed time as M:SS", () => {
		assert.equal(formatElapsed(0), "0:00");
		assert.equal(formatElapsed(393_000), "6:33");
	});

	it("formats a task row with padded time, cost and retries", () => {
		assert.equal(
			buildSummaryTaskLine({ label: "Task 1/3: A", status: "completed", elapsedMs: 393_000, cost: 1.93, retries: 0 }),
			"Task 1/3: A  ✅   6:33  $1.93",
		);
		assert.equal(
			buildSummaryTaskLine({ label: "Task 2/3: B", status: "failed", elapsedMs: 5_000, cost: 0, retries: 2 }),
			"Task 2/3: B  ❌   0:05  (2 retries)",
		);
		assert.equal(buildSummaryTaskLine({ label: "Task 3/3: C", status: "pending", cost: 0, retries: 0 }), "Task 3/3: C  ⏳       ");
	});

	it("formats totals", () => {
		assert.equal(
			buildSummaryTotalsLine({
				prdTitle: "P",
				outcome: "completed",
				tasks: [{ label: "Task 1/1: A", status: "completed", cost: 1, retries: 1 }],
				totalElapsedMs: 125_000,
				totalCost: 3.5,
				totalCommits: 1,
			}),
			"Total: 2:05 | $3.50 | 1 retry | 1 commit",
		);
	});

	it("formats the outcome label without the PRD title", () => {
		assert.equal(buildOutcomeLabel("completed"), "✅ Loop completed");
		assert.equal(buildOutcomeLabel("aborted"), "⚠️ Loop aborted");
	});
});

describe("summary entry", () => {
	const input: SummaryInput = {
		prdTitle: "PRD #1",
		outcome: "failed",
		tasks: [
			{ label: "Task 1/3: A", status: "completed", elapsedMs: 10_000, cost: 0.5, retries: 0 },
			{ label: "Task 2/3: B", status: "failed", elapsedMs: 20_000, cost: 0.25, retries: 1 },
			{ label: "Task 3/3: C", status: "pending", cost: 0, retries: 0 },
		],
		totalElapsedMs: 30_000,
		totalCost: 0.75,
		totalCommits: 1,
	};

	it("shows every task when expanded, without a hint", () => {
		const lines = buildSummaryEntryLines(input, true);
		assert.deepEqual(lines.map((l) => l.kind), ["headline", "blank", "task", "task", "task", "blank", "totals"]);
		assert.equal(lines[0]!.text, "❌ PRD #1 — Loop failed");
		assert.equal(lines.at(-1)!.text, "Total: 0:30 | $0.75 | 1 retry | 1 commit");
	});

	it("shows only failed/aborted tasks when collapsed, plus an expand hint", () => {
		const lines = buildSummaryEntryLines(input, false, "ctrl+x");
		assert.deepEqual(lines.map((l) => l.kind), ["headline", "blank", "task", "blank", "totals", "hint"]);
		assert.equal(lines[2]!.status, "failed");
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
});
