/**
 * PRD Loop Pro — Committer prompt (pure, no pi imports).
 *
 * The commit rules are not duplicated here: they are loaded at runtime from
 * the package's `/commit` prompt template (`prompts/commit.md`, frontmatter
 * stripped), so editing the template changes the committer's behavior. A
 * missing or empty template is a hard error at start.
 *
 * On top of the template rules, the prompt adds the PRD Loop Pro specific
 * constraints:
 * - Conventional Commits without `Refs:`/`Task:` (or any other) footers
 * - never stage or commit anything under `.pi/`
 * - never bypass hooks (`--no-verify` is forbidden) and never try to fix
 *   hook failures — report `hookFailed: true` instead
 *
 * Intentionally free of pi imports so it can be unit-tested with `node --test`
 * (native TypeScript type stripping). Only erasable TypeScript syntax is used.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory that is never staged or committed (todo bookkeeping, settings). */
export const COMMIT_EXCLUDED_DIR = ".pi";

/** Maximum number of changed files listed in the prompt. */
export const COMMIT_MAX_LISTED_FILES = 200;

/** Path of the package's `/commit` prompt template. */
export const COMMIT_TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "commit.md");

/** Remove a leading YAML frontmatter block (`---` … `---`) from a prompt template. */
export function stripFrontmatter(content: string): string {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const match = normalized.match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/);
	return (match ? normalized.slice(match[0].length) : normalized).trim();
}

/**
 * Load the commit rules from the `/commit` prompt template (frontmatter
 * stripped). Throws a descriptive error if the template is missing or empty.
 */
export async function loadCommitRules(templatePath: string = COMMIT_TEMPLATE_PATH): Promise<string> {
	let content: string;
	try {
		content = await readFile(templatePath, "utf-8");
	} catch (err) {
		const reason = (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "file not found" : String(err);
		throw new Error(`/commit prompt template could not be loaded (${templatePath}): ${reason}`);
	}
	const rules = stripFrontmatter(content);
	if (!rules) {
		throw new Error(`/commit prompt template is empty (${templatePath})`);
	}
	return rules;
}

export interface CommitterPromptInput {
	/** Commit rules from the `/commit` prompt template (frontmatter stripped). */
	commitRules: string;
	/** Full task title (context for meaningful commit messages). */
	taskTitle: string;
	/**
	 * Snapshot of the changed files outside `.pi/` (lines of
	 * `git status --porcelain`). Omit if unknown.
	 */
	changedFiles?: string[];
}

function buildChangedFilesSection(changedFiles: string[] | undefined): string[] {
	if (changedFiles === undefined) return [];
	const lines = ["", "## Changed files", ""];
	if (changedFiles.length === 0) {
		lines.push("(none outside `.pi/`)");
		return lines;
	}
	const listed = changedFiles.slice(0, COMMIT_MAX_LISTED_FILES);
	lines.push("Uncommitted changes outside `.pi/` (`git status --porcelain`, `??` = untracked):", "", "```");
	lines.push(...listed);
	if (changedFiles.length > listed.length) {
		lines.push(`… and ${changedFiles.length - listed.length} more`);
	}
	lines.push("```");
	return lines;
}

/**
 * Build the full task prompt for the `prd-committer` subagent.
 */
export function buildCommitterPrompt(input: CommitterPromptInput): string {
	const dir = COMMIT_EXCLUDED_DIR;
	return [
		"Commit the uncommitted changes in this repository.",
		"",
		"## Commit rules",
		"",
		input.commitRules.trim(),
		"",
		"## Additional constraints",
		"",
		"- Every commit message MUST follow the Conventional Commits format: `type(scope): description` (scope optional). Use a meaningful scope for the changed module or area, never a PRD or task id.",
		"- Do NOT add `Refs:`, `Task:` or any other footer/trailer referencing PRDs, tasks or todos.",
		`- NEVER stage or commit anything under \`${dir}/\` (todo bookkeeping and tool settings). Stage files explicitly by path; never use \`git add -A\`, \`git add .\` or \`git commit -a\`. If a file under \`${dir}/\` is staged, unstage it with \`git restore --staged -- ${dir}\` before committing.`,
		"- NEVER bypass git hooks: `--no-verify`, `-n`, `core.hooksPath` overrides and similar tricks are forbidden.",
		"- If a hook (e.g. pre-commit, commit-msg) fails, do NOT try to fix the reported problems, do NOT modify any files and do NOT retry with hooks disabled. Stop immediately and report the failure with `hookFailed: true` and the hook output in `errors`.",
		"- Do not modify file contents; only stage and commit the existing changes.",
		"- Do not amend, rebase, reset or push.",
		...buildChangedFilesSection(input.changedFiles),
		"",
		"## Context",
		"",
		`The changes implement the task: ${input.taskTitle}`,
		"",
		"## Result",
		"",
		"Your very last message must be ONLY a raw JSON object (no prose, no code fences):",
		"",
		'{"success": true, "errors": [], "summary": "Created 2 commits: feat(widget), test(widget)", "hookFailed": false}',
		"",
		"- `success`: true only if all changes outside `.pi/` are committed.",
		"- `errors`: error messages (e.g. hook output) if something failed, otherwise empty.",
		"- `hookFailed`: true if a git hook rejected a commit, otherwise false.",
	].join("\n");
}
