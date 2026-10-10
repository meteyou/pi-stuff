/**
 * PRD Loop Pro — Reviewer prompt (pure, no pi imports).
 *
 * Builds the task prompt for the `prd-reviewer` subagent from the shared
 * review module (`../review/review-prompts.ts`):
 *
 * - shared rubric core + JSON output format
 * - uncommitted-changes focus (staged, unstaged, untracked), excluding `.pi/`
 * - task title + body (incl. acceptance criteria) with the instruction to
 *   report incomplete acceptance criteria and out-of-scope changes as findings
 * - project review guidelines (`REVIEW_GUIDELINES.md`), if any
 *
 * Intentionally free of pi imports so it can be unit-tested with `node --test`
 * (native TypeScript type stripping). Only erasable TypeScript syntax is used.
 */

import {
	REVIEW_RUBRIC_JSON,
	UNCOMMITTED_PROMPT,
	appendProjectReviewGuidelines,
	composeReviewPrompt,
} from "../review/review-prompts.ts";

/** Directory excluded from review (todo bookkeeping, settings). */
export const REVIEW_EXCLUDED_DIR = ".pi";

/** Git pathspec arguments that select the whole repository except `.pi/`. */
export const REVIEW_PATHSPEC: readonly string[] = ["--", ".", `:(exclude)${REVIEW_EXCLUDED_DIR}`];

/** Maximum number of changed files listed in the prompt. */
export const REVIEW_MAX_LISTED_FILES = 200;

export interface ReviewerPromptInput {
	/** Full task title (e.g. "PRD #1 - Task 3/11: Review Phase"). */
	taskTitle: string;
	/** Task body incl. acceptance criteria. */
	taskBody: string;
	/**
	 * Snapshot of the changed files outside `.pi/` (lines of
	 * `git status --porcelain`). Omit if unknown.
	 */
	changedFiles?: string[];
	/** Project review guidelines (`REVIEW_GUIDELINES.md`), or null. */
	projectGuidelines: string | null;
}

/**
 * True if a path (relative to the repository root) lies inside `.pi/`.
 * Accepts plain paths and `git status --porcelain` lines (incl. renames).
 */
export function isExcludedFromReview(pathOrStatusLine: string): boolean {
	const line = pathOrStatusLine.replace(/\r$/, "");
	// `git status --porcelain` lines: "XY path" or "XY old -> new"
	const statusMatch = line.match(/^[ MADRCU?!]{2} (.*)$/);
	const pathPart = statusMatch ? statusMatch[1]! : line;
	const paths = pathPart.split(" -> ").map((p) => p.trim().replace(/^"|"$/g, "").replace(/^\.\//, ""));
	return paths.every((p) => p === REVIEW_EXCLUDED_DIR || p.startsWith(`${REVIEW_EXCLUDED_DIR}/`));
}

/** Filter `git status --porcelain` output to the lines that are part of the review. */
export function filterReviewableStatus(porcelain: string): string[] {
	return porcelain
		.split("\n")
		.map((line) => line.replace(/\r$/, ""))
		.filter((line) => line.trim() !== "")
		.filter((line) => !isExcludedFromReview(line));
}

function quotePathspec(arg: string): string {
	return /^[\w./-]+$/.test(arg) ? arg : `'${arg}'`;
}

function buildScopeSection(changedFiles: string[] | undefined): string {
	const pathspec = REVIEW_PATHSPEC.map(quotePathspec).join(" ");
	const lines = [
		"## Review scope",
		"",
		"- Review ONLY the uncommitted changes in the working tree: staged, unstaged and untracked files.",
		`- Everything under \`${REVIEW_EXCLUDED_DIR}/\` is excluded (todo bookkeeping and tool settings). Do not inspect it for the review and never report findings for files under \`${REVIEW_EXCLUDED_DIR}/\`.`,
		"- Useful read-only commands:",
		`  - \`git status --porcelain --untracked-files=all ${pathspec}\``,
		`  - \`git diff HEAD ${pathspec}\` (staged + unstaged changes of tracked files)`,
		"  - Untracked files do not show up in `git diff`; read them directly.",
		"- You are a reviewer: do not modify any files, do not stage or commit, and do not run commands that change the working tree.",
	];

	if (changedFiles !== undefined) {
		lines.push("");
		if (changedFiles.length === 0) {
			lines.push("Changed files at review start: (none outside `.pi/`)");
		} else {
			const listed = changedFiles.slice(0, REVIEW_MAX_LISTED_FILES);
			lines.push("Changed files at review start (`git status --porcelain`, `??` = untracked):", "", "```");
			lines.push(...listed);
			if (changedFiles.length > listed.length) {
				lines.push(`… and ${changedFiles.length - listed.length} more`);
			}
			lines.push("```");
		}
	}

	return lines.join("\n");
}

function buildTaskSection(taskTitle: string, taskBody: string): string {
	return [
		"## Task under review",
		"",
		"The changes were made by another engineer to implement the following task. Review them against this task.",
		"",
		"<task>",
		`# ${taskTitle}`,
		"",
		taskBody.trim(),
		"</task>",
	].join("\n");
}

const COMPLETENESS_SECTION = [
	"## Completeness and scope",
	"",
	"In addition to the code review rubric, check the changes against the task:",
	"",
	"1. **Incomplete acceptance criteria:** Verify every acceptance criterion and every requirement in \"What to build\". Report each one that is missing or only partially implemented as a finding. Title it `Acceptance criterion not met: <criterion>`, explain what is missing in `body`, and use the file where it should have been implemented as `file` (or an empty string if no single file applies). Use P1 if core functionality of the task is missing, otherwise P2.",
	"2. **Out-of-scope changes:** Report changes that are not required by the task (unrelated refactors, features or files) as findings. Title them `Out-of-scope change: <what>`. Use P2 if they add risk, otherwise P3.",
	"3. Completeness findings are the only exception to the rule that findings must reference locations overlapping with the diff.",
	"4. Criteria that can only be verified manually (e.g. UI behavior) are not findings if the code plausibly implements them.",
].join("\n");

const FINAL_REMINDER =
	"Remember: your final message must be a single raw JSON object matching the output format above — no prose, no code fences.";

/**
 * Build the full task prompt for the `prd-reviewer` subagent.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
	const focus = [
		UNCOMMITTED_PROMPT,
		"",
		buildScopeSection(input.changedFiles),
		"",
		buildTaskSection(input.taskTitle, input.taskBody),
		"",
		COMPLETENESS_SECTION,
	].join("\n");

	const prompt = appendProjectReviewGuidelines(composeReviewPrompt(REVIEW_RUBRIC_JSON, focus), input.projectGuidelines);
	return `${prompt}\n\n---\n\n${FINAL_REMINDER}`;
}
