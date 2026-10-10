import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DISCARD_PATHSPEC, discardChanges } from "./discard.ts";
import type { GitExec } from "./discard.ts";

let repo: string;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

const exec: GitExec = async (args) => {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
	return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function write(path: string, content: string): void {
	const full = join(repo, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf-8");
}

function read(path: string): string {
	return readFileSync(join(repo, path), "utf-8");
}

function initRepo(): void {
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	git("config", "commit.gpgsign", "false");
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "prd-loop-pro-discard-"));
	initRepo();
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "discard.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});

	it("excludes .pi/ from the pathspec", () => {
		assert.deepEqual(DISCARD_PATHSPEC, ["--", ".", ":(exclude).pi"]);
	});
});

describe("discardChanges", () => {
	it("discards code changes but leaves a tracked .pi/ untouched", async () => {
		write("src/a.ts", "original\n");
		write("src/keep.ts", "keep\n");
		write(".pi/todos/task.md", '{ "status": "open" }\n');
		write(".pi/todos/prd.md", '{ "status": "open" }\n');
		git("add", "-A");
		git("commit", "-q", "-m", "init");

		// Code changes: modified (unstaged + staged), deleted, new staged, untracked file/dir
		write("src/a.ts", "changed\n");
		write("src/keep.ts", "staged change\n");
		git("add", "src/keep.ts");
		write("src/new-staged.ts", "new\n");
		git("add", "src/new-staged.ts");
		write("src/untracked.ts", "untracked\n");
		write("generated/deep/file.txt", "x\n");

		// .pi/ bookkeeping changes: modified (unstaged + staged), new untracked, deleted
		write(".pi/todos/task.md", '{ "status": "needs-human" }\n');
		write(".pi/todos/prd.md", '{ "status": "closed" }\n');
		git("add", ".pi/todos/prd.md");
		write(".pi/todos/new.md", '{ "status": "open" }\n');

		await discardChanges(exec);

		assert.equal(read("src/a.ts"), "original\n");
		assert.equal(read("src/keep.ts"), "keep\n");
		assert.equal(existsSync(join(repo, "src/new-staged.ts")), false);
		assert.equal(existsSync(join(repo, "src/untracked.ts")), false);
		assert.equal(existsSync(join(repo, "generated")), false);

		assert.equal(read(".pi/todos/task.md"), '{ "status": "needs-human" }\n');
		assert.equal(read(".pi/todos/prd.md"), '{ "status": "closed" }\n');
		assert.equal(read(".pi/todos/new.md"), '{ "status": "open" }\n');

		// Only .pi/ changes remain (the staged .pi change stays staged)
		const status = git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).sort();
		assert.deepEqual(status, ["?? .pi/todos/new.md", "M  .pi/todos/prd.md", " M .pi/todos/task.md"].sort());
	});

	it("restores tracked files deleted by the implementation", async () => {
		write("src/a.ts", "a\n");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		rmSync(join(repo, "src/a.ts"));

		await discardChanges(exec);

		assert.equal(read("src/a.ts"), "a\n");
	});

	it("leaves an untracked or gitignored .pi/ untouched", async () => {
		write(".gitignore", ".pi/\n");
		write("src/a.ts", "a\n");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		write(".pi/todos/task.md", "todo\n");
		write("src/a.ts", "changed\n");
		write("src/b.ts", "b\n");

		await discardChanges(exec);

		assert.equal(read("src/a.ts"), "a\n");
		assert.equal(existsSync(join(repo, "src/b.ts")), false);
		assert.equal(read(".pi/todos/task.md"), "todo\n");
	});

	it("works in a repository without commits", async () => {
		write(".pi/todos/task.md", "todo\n");
		write("src/a.ts", "a\n");
		git("add", "-A");

		await discardChanges(exec);

		assert.equal(existsSync(join(repo, "src/a.ts")), false);
		assert.equal(read(".pi/todos/task.md"), "todo\n");
		assert.deepEqual(git("status", "--porcelain").split("\n").filter(Boolean), ["A  .pi/todos/task.md"]);
	});

	it("is a no-op when only .pi/ is tracked and nothing changed outside it", async () => {
		write(".pi/todos/task.md", "todo\n");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		write(".pi/todos/task.md", "changed\n");

		await discardChanges(exec);

		assert.equal(read(".pi/todos/task.md"), "changed\n");
	});

	it("throws when git fails", async () => {
		const failing: GitExec = async (args) =>
			args[0] === "rev-parse" ? { code: 0, stdout: "abc\n", stderr: "" } : { code: 128, stdout: "", stderr: "fatal: boom" };
		await assert.rejects(discardChanges(failing), /fatal: boom/);
	});
});
