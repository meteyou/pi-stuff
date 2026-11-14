/**
 * PRD Loop Pro — Discard uncommitted code changes (no pi imports).
 *
 * Used by "Retry task", "Skip task" and "Split task". Discards all
 * uncommitted changes (staged, unstaged and untracked) EXCEPT everything under
 * `.pi/`, so todo bookkeeping (task status, execution reports, PRD Task Index)
 * is never lost — also when `.pi/` is tracked by git.
 *
 * Before a discard the changes are saved as a git stash (`snapshotChanges`),
 * so a discard can always be undone with `git stash apply <ref>`.
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

/** Uncommitted changes saved as a git stash before a discard. */
export interface ChangeSnapshot {
	/** Commit SHA of the stash entry (stable while the entry exists; `git stash apply <ref>` restores it). */
	ref: string;
	/** Stash message (shown by `git stash list`). */
	message: string;
}

/**
 * Save all uncommitted changes outside `.pi/` (staged, unstaged and
 * untracked) as a git stash entry and remove them from the working tree.
 *
 * Returns `undefined` when there is nothing to save or the repository has no
 * commit yet (a stash needs one). Call `discardChanges` afterwards to clean
 * up whatever the stash did not cover.
 */
export async function snapshotChanges(git: GitExec, message: string): Promise<ChangeSnapshot | undefined> {
	const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
	if (head.code !== 0 || head.stdout.trim() === "") return undefined;

	const status = await git(["status", "--porcelain", "--untracked-files=all", ...DISCARD_PATHSPEC]);
	if (status.code !== 0) throw new Error(`git status failed: ${(status.stderr || status.stdout).trim()}`);
	if (status.stdout.trim() === "") return undefined;

	const stashRef = async () => {
		const result = await git(["rev-parse", "--verify", "--quiet", "refs/stash"]);
		return result.code === 0 ? result.stdout.trim() : "";
	};
	const before = await stashRef();
	const cleanMessage = message.replace(/\s+/g, " ").trim();
	await run(git, ["stash", "push", "--include-untracked", "-m", cleanMessage, ...DISCARD_PATHSPEC]);
	const after = await stashRef();
	if (!after || after === before) throw new Error("git stash did not create a snapshot of the changes");
	return { ref: after, message: cleanMessage };
}
