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

const SECOND: ReviewFinding = {
	priority: "P2",
	title: "  Missing\n test ",
	file: "",
	body: "",
};

describe("buildFixerPrompt", () => {
	const prompt = buildFixerPrompt({ taskTitle: TASK_TITLE, taskBody: TASK_BODY, findings: [FINDING, SECOND], round: 2, prdId: "TODO-abc123" });

	it("lists all findings numbered with priority, location and explanation", () => {
		assert.match(prompt, /^# Fix 2 review findings \(review round 2\)/);
		assert.match(prompt, /### Finding 1: \[P1\] Missing null check\n\n- \*\*Location:\*\* `src\/widget\.ts:12`/);
		assert.ok(prompt.includes(FINDING.body));
		assert.match(prompt, /### Finding 2: \[P2\] Missing test\n\n- \*\*Location:\*\* `\(no specific file — see explanation\)`\n\n\(no explanation given\)/);
		assert.match(prompt, /every listed finding/);
		assert.ok(prompt.indexOf("### Finding 1") < prompt.indexOf("### Finding 2"));
	});

	it("contains task title and body incl. acceptance criteria", () => {
		assert.ok(prompt.includes(`# ${TASK_TITLE}`));
		assert.ok(prompt.includes("- [ ] Widget has tests"));
		assert.match(prompt, /PRD todo: TODO-abc123/);
	});

	it("requires running the relevant tests/checks once after all fixes", () => {
		assert.match(prompt, /Run the relevant tests and checks once, after all fixes/);
		assert.match(prompt, /Do not run the full checks after each individual fix/);
	});

	it("allows rejecting findings with a reason", () => {
		assert.match(prompt, /Reject invalid findings/);
		assert.match(prompt, /"status": "rejected"/);
	});

	it("forbids git write operations and .pi/", () => {
		assert.match(prompt, /NEVER commit, stage/);
		assert.match(prompt, /NEVER touch anything under `\.pi\/`/);
	});

	it("ends with the JSON output format (one result per finding by id)", () => {
		assert.ok(prompt.endsWith(FIXER_OUTPUT_FORMAT));
		for (const key of ["results", "id", "status", "reason", "summary", "verification"]) {
			assert.ok(FIXER_OUTPUT_FORMAT.includes(`"${key}"`), key);
		}
		assert.match(FIXER_OUTPUT_FORMAT, /exactly one entry per finding/);
	});

	it("handles a single finding without round/prd", () => {
		const minimal = buildFixerPrompt({ taskTitle: TASK_TITLE, taskBody: TASK_BODY, findings: [FINDING] });
		assert.match(minimal, /^# Fix 1 review finding\n/);
		assert.match(minimal, /address \*\*this finding\*\*/);
		assert.match(minimal, /### Finding 1: \[P1\] Missing null check/);
		assert.doesNotMatch(minimal, /review round/);
		assert.doesNotMatch(minimal, /PRD todo/);
	});
});
