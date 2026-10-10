import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	REVIEW_HUMAN_CALLOUTS_SECTION,
	REVIEW_JSON_OUTPUT_FORMAT,
	REVIEW_MARKDOWN_OUTPUT_FORMAT,
	REVIEW_PRIORITY_LEVELS,
	REVIEW_RUBRIC_CORE,
	REVIEW_RUBRIC_CORE_GUIDELINES,
	REVIEW_RUBRIC_JSON,
	REVIEW_RUBRIC_MARKDOWN,
	UNCOMMITTED_PROMPT,
	appendProjectReviewGuidelines,
	composeReviewPrompt,
	loadProjectReviewGuidelines,
} from "./review-prompts.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** SHA-256 of the monolithic REVIEW_RUBRIC from before the shared-module refactor. */
const ORIGINAL_RUBRIC_SHA256 = "018246932a085eb7ae2ee587731bc57b279bb428c8ebcce2f4aef31b9d17307c";

describe("markdown rubric (/review)", () => {
	it("is byte-identical to the original rubric", () => {
		assert.equal(sha256(REVIEW_RUBRIC_MARKDOWN), ORIGINAL_RUBRIC_SHA256);
	});

	it("keeps the original section order", () => {
		const order = [
			REVIEW_RUBRIC_CORE_GUIDELINES,
			REVIEW_HUMAN_CALLOUTS_SECTION,
			REVIEW_PRIORITY_LEVELS,
			REVIEW_MARKDOWN_OUTPUT_FORMAT,
		].map((part) => REVIEW_RUBRIC_MARKDOWN.indexOf(part));
		assert.ok(order.every((index) => index >= 0));
		assert.deepEqual(order, [...order].sort((a, b) => a - b));
	});

	it("composes the review prompt like before", () => {
		const prompt = composeReviewPrompt(REVIEW_RUBRIC_MARKDOWN, UNCOMMITTED_PROMPT);
		assert.equal(
			prompt,
			`${REVIEW_RUBRIC_MARKDOWN}\n\n---\n\nPlease perform a code review with the following focus:\n\n${UNCOMMITTED_PROMPT}`,
		);
		assert.equal(appendProjectReviewGuidelines(prompt, null), prompt);
		assert.equal(
			appendProjectReviewGuidelines(prompt, "Rules"),
			`${prompt}\n\nThis project has additional instructions for code reviews:\n\nRules`,
		);
	});
});

describe("core rubric", () => {
	it("contains no output-format or callout section", () => {
		assert.ok(!REVIEW_RUBRIC_CORE.includes("## Output format"));
		assert.ok(!REVIEW_RUBRIC_CORE.includes("Human Reviewer Callouts"));
		for (const heading of [
			"## Determining what to flag",
			"## Untrusted User Input",
			"## Comment guidelines",
			"## Review priorities",
			"## Fail-fast error handling (strict)",
			"## Priority levels",
		]) {
			assert.ok(REVIEW_RUBRIC_CORE.includes(heading), heading);
		}
	});
});

describe("JSON rubric (prd-loop-pro)", () => {
	it("is core + JSON output format", () => {
		assert.ok(REVIEW_RUBRIC_JSON.startsWith(REVIEW_RUBRIC_CORE));
		assert.ok(REVIEW_RUBRIC_JSON.endsWith(REVIEW_JSON_OUTPUT_FORMAT));
		assert.ok(!REVIEW_RUBRIC_JSON.includes("Human Reviewer Callouts (Non-Blocking)"));
	});

	it("defines the full result contract", () => {
		for (const token of [
			'"verdict": "correct" | "needs attention"',
			'"summary": string',
			'"findings"',
			'"priority": "P0" | "P1" | "P2" | "P3"',
			'"title": string',
			'"file": string',
			'"line": number',
			'"body": string',
			'"callouts": [string]',
		]) {
			assert.ok(REVIEW_JSON_OUTPUT_FORMAT.includes(token), token);
		}
		assert.match(REVIEW_JSON_OUTPUT_FORMAT, /`line`: optional/);
		assert.match(REVIEW_JSON_OUTPUT_FORMAT, /final message MUST be a single raw JSON object/);
		assert.match(REVIEW_JSON_OUTPUT_FORMAT, /no markdown code fences/);
	});
});

describe("loadProjectReviewGuidelines", () => {
	it("loads REVIEW_GUIDELINES.md next to the nearest .pi directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "review-guidelines-"));
		try {
			mkdirSync(join(root, ".pi"));
			mkdirSync(join(root, "a", "b"), { recursive: true });
			assert.equal(await loadProjectReviewGuidelines(join(root, "a", "b")), null);

			writeFileSync(join(root, "REVIEW_GUIDELINES.md"), "\n  Be strict.  \n");
			assert.equal(await loadProjectReviewGuidelines(join(root, "a", "b")), "Be strict.");

			writeFileSync(join(root, "REVIEW_GUIDELINES.md"), "   \n");
			assert.equal(await loadProjectReviewGuidelines(root), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
