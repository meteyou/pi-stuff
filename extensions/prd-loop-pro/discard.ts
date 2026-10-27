/**
 * PRD Loop Pro — Discard uncommitted code changes (no pi imports).
 *
 * Used by "Retry task" and "Skip task". Discards all uncommitted changes
 * (staged, unstaged and untracked) EXCEPT everything under `.pi/`, so todo
 * bookkeeping (task status, execution reports, PRD Task Index) is never lost —
 * also when `.pi/` is tracked by git.
 *
 * Git is injected (`GitExec`) so the module can be tested against a real
 * temporary repository with `node --test`.
 */

import { REVIEW_EXCLUDED_DIR } from "./reviewer-prompt.ts";

/** Runs `git <args>` in the working directory of the loop. */
export type GitExec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Pathspec covering the working directory except `.pi/`. */
export const DISCARD_PATHSPEC: readonly string[] = ["--", ".", `:(exclude)${REVIEW_EXCLUDED_DIR}`];

async function run(git: GitExec, args: string[]): Promise<void> {
	const result = await git(args);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
}

/**
 * Discard all uncommitted changes outside `.pi/`:
 * - tracked files (index + working tree) are restored to HEAD,
 * - files staged in a repository without commits are unstaged,
 * - untracked files and directories are removed (ignored files are kept).
 *
 * Changes under `.pi/` (staged or not, tracked or untracked) stay untouched.
 */
export async function discardChanges(git: GitExec): Promise<void> {
	const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
	if (head.code === 0 && head.stdout.trim() !== "") {
		await run(git, ["restore", "--source=HEAD", "--staged", "--worktree", ...DISCARD_PATHSPEC]);
	} else {
		// No commits yet: nothing to restore, only unstage added files.
		await run(git, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", ...DISCARD_PATHSPEC]);
	}
	await run(git, ["clean", "-f", "-d", "-q", ...DISCARD_PATHSPEC]);
}
