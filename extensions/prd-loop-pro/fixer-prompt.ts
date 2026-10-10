/**
 * PRD Loop Pro — Fixer prompt (pure, no pi imports).
 *
 * Builds the task prompt for the `prd-fixer` subagent. Every finding at/above
 * the fix threshold gets its own fresh fixer with:
 *
 * - the task title + body (incl. acceptance criteria) as context
 * - exactly one review finding (priority, title, location, explanation)
 * - the instruction to verify the finding first, fix only this finding, run
 *   the relevant tests/checks afterwards, and to reject it with a concrete
 *   reason if it is not valid
 * - the JSON result contract `{ status, reason, summary, verification }`
 *
 * Intentionally free of pi imports so it can be unit-tested with `node --test`
 * (native TypeScript type stripping). Only erasable TypeScript syntax is used.
 */

import type { ReviewFinding } from "./subagent-result.ts";

/** Directory the fixer must never touch (todo bookkeeping, settings). */
export const FIX_EXCLUDED_DIR = ".pi";

export interface FixerPromptInput {
	/** Full task title (e.g. "PRD #1 - Task 4/11: Review-Fix Cycle"). */
	taskTitle: string;
	/** Task body incl. acceptance criteria. */
	taskBody: string;
	/** The single finding to address. */
	finding: ReviewFinding;
	/** Review round in which the finding was raised (1-based). */
	round?: number;
	/** PRD todo id for further context (e.g. "TODO-c7f86cf4"). */
	prdId?: string;
}

function formatLocation(finding: ReviewFinding): string {
	const file = finding.file.trim();
	if (!file) return "(no specific file — see explanation)";
	return finding.line !== undefined && finding.line > 0 ? `${file}:${finding.line}` : file;
}

export const FIXER_OUTPUT_FORMAT = [
	"## Output format",
	"",
	"Your **very last message** must be ONLY a raw JSON object — no prose before or after it, no markdown code fences:",
	"",
	'{"status": "fixed", "reason": "Why the finding was valid", "summary": "What you changed", "verification": "Which tests/checks you ran and their result"}',
	"",
	"or, if you reject the finding:",
	"",
	'{"status": "rejected", "reason": "Concrete reason why the finding is not valid or should not be fixed", "summary": "What you checked", "verification": "How you verified that (files read, tests run)"}',
	"",
	"- `status`: `\"fixed\"` or `\"rejected\"`.",
	"- `reason`: required for `rejected` — be concrete (reference code, the task or acceptance criteria); the reason is shown to the next reviewer.",
	"- `summary`: one or two sentences.",
	"- `verification`: the commands you ran (tests, type check, build, lint) and whether they passed.",
].join("\n");

/**
 * Build the full task prompt for the `prd-fixer` subagent.
 */
export function buildFixerPrompt(input: FixerPromptInput): string {
	const { finding } = input;
	const title = finding.title.replace(/\s+/g, " ").trim() || "(untitled)";
	const raisedIn = input.round !== undefined ? ` (raised in review round ${input.round})` : "";

	const lines = [
		`# Fix review finding: [${finding.priority}] ${title}`,
		"",
		"Another engineer implemented the task below; the changes are uncommitted in the working tree. " +
			`A code review of these changes raised the finding below${raisedIn}. ` +
			"Your job is to address **exactly this one finding**: fix it, or reject it with a concrete reason if it is not valid.",
		"",
		"## Finding",
		"",
		`- **Priority:** ${finding.priority}`,
		`- **Title:** ${title}`,
		`- **Location:** \`${formatLocation(finding)}\``,
		"",
		"**Explanation:**",
		"",
		finding.body.trim() || "(no explanation given)",
		"",
		"## Task context",
		"",
		"<task>",
		`# ${input.taskTitle}`,
		"",
		input.taskBody.trim(),
		"</task>",
	];
	if (input.prdId) {
		lines.push("", `If you need more context about the overall project, read the PRD todo: ${input.prdId}`);
	}
	lines.push(
		"",
		"## Instructions",
		"",
		"1. **Verify the finding first.** Read the referenced code and the uncommitted changes " +
			`(\`git status --porcelain --untracked-files=all -- . ':(exclude)${FIX_EXCLUDED_DIR}'\`, ` +
			`\`git diff HEAD -- . ':(exclude)${FIX_EXCLUDED_DIR}'\`; untracked files must be read directly). Decide whether the finding is valid.`,
		"2. **If it is valid, fix exactly this finding** with the smallest correct change. Do not address other findings, do not refactor unrelated code and stay within the scope of the task.",
		"3. **Run the relevant tests and checks after the fix** (test suite, type check, build, lint — whatever the project uses) and make sure they pass. Add or adjust tests if the fix changes behavior. Report what you ran in `verification`.",
		"4. **If it is not valid** (false positive, contradicts the task or its acceptance criteria, already handled elsewhere, or the change would make the code worse), do not change any code and reject it with a concrete reason.",
		"5. If you cannot fix it properly (e.g. the checks keep failing), revert your own changes for this finding and reject it, explaining what blocks the fix.",
		"",
		"## Rules",
		"",
		"- NEVER commit, stage, stash, reset, checkout or clean — the orchestrator handles all git operations. Other uncommitted changes in the working tree belong to the task and must be kept.",
		`- NEVER touch anything under \`${FIX_EXCLUDED_DIR}/\` (todos, settings) and do not use the todo tool.`,
		"",
		FIXER_OUTPUT_FORMAT,
	);
	return lines.join("\n");
}
