import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	COMMIT_TEMPLATE_PATH,
	buildCommitterPrompt,
	loadCommitRules,
	stripFrontmatter,
} from "./committer-prompt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "prd-loop-pro-committer-"));
	return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(HERE, "committer-prompt.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
		assert.doesNotMatch(source, /from\s+["']@mariozechner\//);
	});
});

describe("stripFrontmatter", () => {
	it("removes a leading frontmatter block", () => {
		assert.equal(stripFrontmatter("---\ndescription: x\n---\nBody line\n"), "Body line");
	});

	it("handles CRLF line endings", () => {
		assert.equal(stripFrontmatter("---\r\ndescription: x\r\n---\r\nBody\r\n"), "Body");
	});

	it("keeps content without frontmatter", () => {
		assert.equal(stripFrontmatter("Just rules\n---\nmore"), "Just rules\n---\nmore");
	});
});

describe("loadCommitRules", () => {
	it("loads the package's /commit prompt template without frontmatter", async () => {
		const rules = await loadCommitRules();
		const raw = readFileSync(COMMIT_TEMPLATE_PATH, "utf-8");
		assert.ok(raw.startsWith("---"), "template has frontmatter");
		assert.doesNotMatch(rules, /^---/);
		assert.doesNotMatch(rules, /^description:/m);
		assert.match(rules, /Conventional Commits/);
	});

	it("reflects edits to the template", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "commit.md");
			writeFileSync(path, "---\ndescription: test\n---\nRule A\n");
			assert.equal(await loadCommitRules(path), "Rule A");
			writeFileSync(path, "---\ndescription: test\n---\nRule B\n");
			assert.equal(await loadCommitRules(path), "Rule B");
		});
	});

	it("throws for a missing template", async () => {
		await withTempDir(async (dir) => {
			await assert.rejects(loadCommitRules(join(dir, "missing.md")), /\/commit prompt template could not be loaded.*file not found/);
		});
	});

	it("throws for a template that is empty after stripping frontmatter", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "commit.md");
			writeFileSync(path, "---\ndescription: test\n---\n\n");
			await assert.rejects(loadCommitRules(path), /empty/);
		});
	});
});

describe("buildCommitterPrompt", () => {
	const prompt = buildCommitterPrompt({
		commitRules: "RULES FROM TEMPLATE",
		taskTitle: "PRD #9 - Task 1/2: Add widget",
		changedFiles: [" M src/widget.ts", "?? src/widget.test.ts"],
	});

	it("contains the template rules and task context", () => {
		assert.match(prompt, /RULES FROM TEMPLATE/);
		assert.match(prompt, /PRD #9 - Task 1\/2: Add widget/);
		assert.match(prompt, /src\/widget\.ts/);
		assert.match(prompt, /src\/widget\.test\.ts/);
	});

	it("requires Conventional Commits without Refs/Task footers", () => {
		assert.match(prompt, /Conventional Commits/);
		assert.match(prompt, /Do NOT add `Refs:`, `Task:`/);
		assert.doesNotMatch(prompt, /Refs: prd-/);
	});

	it("forbids committing .pi/ and bypassing hooks", () => {
		assert.match(prompt, /NEVER stage or commit anything under `\.pi\/`/);
		assert.match(prompt, /--no-verify/);
		assert.match(prompt, /hookFailed: true/);
		assert.match(prompt, /do NOT try to fix/);
	});

	it("describes the JSON result contract", () => {
		assert.match(prompt, /"success"/);
		assert.match(prompt, /"errors"/);
		assert.match(prompt, /"summary"/);
		assert.match(prompt, /"hookFailed"/);
	});

	it("truncates long file lists", () => {
		const many = Array.from({ length: 205 }, (_, i) => ` M file-${i}.ts`);
		const p = buildCommitterPrompt({ commitRules: "R", taskTitle: "T", changedFiles: many });
		assert.match(p, /… and 5 more/);
		assert.doesNotMatch(p, /file-204\.ts/);
	});
});
