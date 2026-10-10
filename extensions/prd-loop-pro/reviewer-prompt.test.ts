import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	REVIEW_JSON_OUTPUT_FORMAT,
	REVIEW_RUBRIC_CORE,
	UNCOMMITTED_PROMPT,
} from "../review/review-prompts.ts";
import {
	REVIEW_PATHSPEC,
	buildReviewerPrompt,
	filterReviewableStatus,
	isExcludedFromReview,
} from "./reviewer-prompt.ts";

const TASK_TITLE = "PRD #9 - Task 1/2: Add widget";
const TASK_BODY = "## What to build\n\nA widget.\n\n## Acceptance criteria\n\n- [ ] Widget renders\n- [ ] Widget has tests";

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "reviewer-prompt.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
		assert.doesNotMatch(source, /from\s+["']@mariozechner\//);
	});
});

describe("buildReviewerPrompt", () => {
	const prompt = buildReviewerPrompt({
		taskTitle: TASK_TITLE,
		taskBody: TASK_BODY,
		changedFiles: [" M src/widget.ts", "?? src/widget.test.ts"],
		projectGuidelines: "Always use tabs.",
	});

	it("contains the shared rubric core and the JSON output format", () => {
		assert.ok(prompt.includes(REVIEW_RUBRIC_CORE));
		assert.ok(prompt.includes(REVIEW_JSON_OUTPUT_FORMAT));
		assert.ok(prompt.indexOf(REVIEW_RUBRIC_CORE) < prompt.indexOf(REVIEW_JSON_OUTPUT_FORMAT));
	});

	it("does not contain the markdown-only output format", () => {
		assert.doesNotMatch(prompt, /Human Reviewer Callouts \(Non-Blocking\)/);
	});

	it("focuses on uncommitted changes incl. untracked files", () => {
		assert.ok(prompt.includes(UNCOMMITTED_PROMPT));
		assert.match(prompt, /untracked/);
	});

	it("excludes .pi/ from the review scope", () => {
		assert.match(prompt, /under `\.pi\/` is excluded/);
		assert.match(prompt, /never report findings for files under `\.pi\/`/);
		assert.match(prompt, /git diff HEAD -- \. ':\(exclude\)\.pi'/);
	});

	it("lists the changed files", () => {
		assert.match(prompt, / M src\/widget\.ts\n\?\? src\/widget\.test\.ts/);
	});

	it("contains task title and body incl. acceptance criteria", () => {
		assert.ok(prompt.includes(`# ${TASK_TITLE}`));
		assert.ok(prompt.includes("- [ ] Widget has tests"));
	});

	it("instructs to report incomplete acceptance criteria and out-of-scope changes", () => {
		assert.match(prompt, /Acceptance criterion not met/);
		assert.match(prompt, /Out-of-scope change/);
	});

	it("appends project review guidelines", () => {
		assert.match(prompt, /additional instructions for code reviews:\n\nAlways use tabs\./);
	});

	it("ends with the raw JSON reminder", () => {
		assert.match(prompt, /single raw JSON object[^\n]*$/);
	});

	it("omits guidelines when there are none", () => {
		const noGuidelines = buildReviewerPrompt({ taskTitle: TASK_TITLE, taskBody: TASK_BODY, projectGuidelines: null });
		assert.doesNotMatch(noGuidelines, /additional instructions for code reviews/);
		assert.doesNotMatch(noGuidelines, /Changed files at review start/);
	});

	it("notes when no files changed outside .pi/", () => {
		const empty = buildReviewerPrompt({ taskTitle: TASK_TITLE, taskBody: TASK_BODY, changedFiles: [], projectGuidelines: null });
		assert.match(empty, /Changed files at review start: \(none outside `\.pi\/`\)/);
	});
});

describe(".pi exclusion helpers", () => {
	it("uses a git pathspec that excludes .pi", () => {
		assert.deepEqual([...REVIEW_PATHSPEC], ["--", ".", ":(exclude).pi"]);
	});

	it("isExcludedFromReview detects .pi paths and status lines", () => {
		assert.equal(isExcludedFromReview(".pi/todos/abc.md"), true);
		assert.equal(isExcludedFromReview(".pi"), true);
		assert.equal(isExcludedFromReview(" M .pi/todos/abc.md"), true);
		assert.equal(isExcludedFromReview("?? .pi/prd-loop-pro.json"), true);
		assert.equal(isExcludedFromReview("R  .pi/a.md -> .pi/b.md"), true);
		assert.equal(isExcludedFromReview("R  .pi/a.md -> src/b.md"), false);
		assert.equal(isExcludedFromReview(" M src/.pi.ts"), false);
		assert.equal(isExcludedFromReview("?? .pinned/file"), false);
		assert.equal(isExcludedFromReview("src/app.ts"), false);
	});

	it("filterReviewableStatus drops .pi and blank lines", () => {
		const porcelain = " M src/a.ts\n M .pi/todos/x.md\n?? src/b.ts\n\n?? .pi/y.json\n";
		assert.deepEqual(filterReviewableStatus(porcelain), [" M src/a.ts", "?? src/b.ts"]);
	});
});
