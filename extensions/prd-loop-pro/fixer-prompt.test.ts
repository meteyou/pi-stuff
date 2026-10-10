import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXER_OUTPUT_FORMAT, buildFixerPrompt } from "./fixer-prompt.ts";
import type { ReviewFinding } from "./subagent-result.ts";

const TASK_TITLE = "PRD #9 - Task 1/2: Add widget";
const TASK_BODY = "## What to build\n\nA widget.\n\n## Acceptance criteria\n\n- [ ] Widget renders\n- [ ] Widget has tests";
const FINDING: ReviewFinding = {
	priority: "P1",
	title: "Missing null check",
	file: "src/widget.ts",
	line: 12,
	body: "`opts` may be undefined when called from the CLI.",
};

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixer-prompt.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
		assert.doesNotMatch(source, /from\s+["']@mariozechner\//);
	});
});

describe("buildFixerPrompt", () => {
	const prompt = buildFixerPrompt({ taskTitle: TASK_TITLE, taskBody: TASK_BODY, finding: FINDING, round: 2, prdId: "TODO-abc123" });

	it("contains exactly the one finding with priority, location and explanation", () => {
		assert.match(prompt, /^# Fix review finding: \[P1\] Missing null check/);
		assert.match(prompt, /\*\*Location:\*\* `src\/widget\.ts:12`/);
		assert.ok(prompt.includes(FINDING.body));
		assert.match(prompt, /raised in review round 2/);
		assert.match(prompt, /exactly this one finding/);
	});

	it("contains task title and body incl. acceptance criteria", () => {
		assert.ok(prompt.includes(`# ${TASK_TITLE}`));
		assert.ok(prompt.includes("- [ ] Widget has tests"));
		assert.match(prompt, /PRD todo: TODO-abc123/);
	});

	it("requires running the relevant tests/checks", () => {
		assert.match(prompt, /Run the relevant tests and checks after the fix/);
	});

	it("allows rejecting the finding with a reason", () => {
		assert.match(prompt, /reject it with a concrete reason/);
		assert.match(prompt, /"status": "rejected"/);
	});

	it("forbids git write operations and .pi/", () => {
		assert.match(prompt, /NEVER commit, stage/);
		assert.match(prompt, /NEVER touch anything under `\.pi\/`/);
	});

	it("ends with the JSON output format", () => {
		assert.ok(prompt.endsWith(FIXER_OUTPUT_FORMAT));
		for (const key of ["status", "reason", "summary", "verification"]) {
			assert.ok(FIXER_OUTPUT_FORMAT.includes(`"${key}"`), key);
		}
	});

	it("handles findings without file/line and without round/prd", () => {
		const minimal = buildFixerPrompt({
			taskTitle: TASK_TITLE,
			taskBody: TASK_BODY,
			finding: { priority: "P0", title: "Acceptance criterion not met: tests", file: "", body: "" },
		});
		assert.match(minimal, /`\(no specific file — see explanation\)`/);
		assert.match(minimal, /\(no explanation given\)/);
		assert.doesNotMatch(minimal, /raised in review round/);
		assert.doesNotMatch(minimal, /PRD todo/);
	});
});
