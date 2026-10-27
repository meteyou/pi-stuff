/**
 * PRD Loop Pro — Fixer prompt (pure, no pi imports).
 *
 * Builds the task prompt for the `prd-fixer` subagent. All findings of a
 * review round at/above the fix threshold go to one fresh fixer (batch) with:
 *
 * - the task title + body (incl. acceptance criteria) as context
 * - the numbered review findings (priority, title, location, explanation),
 *   most severe first
 * - the instruction to verify each finding, fix the valid ones, reject the
 *   others with a concrete reason, and to run the relevant tests/checks once
 *   after all fixes (instead of once per finding)
 * - the JSON result contract `{ results: [{ id, status, reason, summary }], verification }`
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
	/** The findings to address, numbered from 1 in this order (ids in the result). */
	findings: readonly ReviewFinding[];
	/** Review round in which the findings were raised (1-based). */
	round?: number;
	/** PRD todo id for further context (e.g. "TODO-c7f86cf4"). */
	prdId?: string;
}

function formatLocation(finding: ReviewFinding): string {
	const file = finding.file.trim();
	if (!file) return "(no specific file — see explanation)";
	return finding.line !== undefined && finding.line > 0 ? `${file}:${finding.line}` : file;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export const FIXER_OUTPUT_FORMAT = [
	"## Output format",
	"",
	"Your **very last message** must be ONLY a raw JSON object — no prose before or after it, no markdown code fences:",
	"",
	'{"results": [{"id": 1, "status": "fixed", "reason": "Why the finding was valid", "summary": "What you changed"}, ' +
		'{"id": 2, "status": "rejected", "reason": "Concrete reason why the finding is not valid or should not be fixed", "summary": "What you checked"}], ' +
		'"verification": "Which tests/checks you ran after all fixes and their result"}',
	"",
	"- `results`: exactly one entry per finding.",
	"- `id`: the finding number from this prompt (`Finding 1` → `1`).",
	"- `status`: `\"fixed\"` or `\"rejected\"`.",
	"- `reason`: required for `rejected` — be concrete (reference code, the task or acceptance criteria); the reason is shown to the next reviewer.",
	"- `summary`: one or two sentences.",
	"- `verification`: the commands you ran after all fixes (tests, type check, build, lint) and whether they passed.",
].join("\n");

/** One numbered finding section. */
function formatFinding(finding: ReviewFinding, id: number): string[] {
	const title = oneLine(finding.title) || "(untitled)";
	return [
		`### Finding ${id}: [${finding.priority}] ${title}`,
		"",
		`- **Location:** \`${formatLocation(finding)}\``,
		"",
		finding.body.trim() || "(no explanation given)",
	];
}

/**
 * Build the full task prompt for the `prd-fixer` subagent.
 */
export function buildFixerPrompt(input: FixerPromptInput): string {
	const count = input.findings.length;
	const noun = count === 1 ? "finding" : "findings";
	const raisedIn = input.round !== undefined ? ` (review round ${input.round})` : "";

	const lines = [
		`# Fix ${count} review ${noun}${raisedIn}`,
		"",
		"Another engineer implemented the task below; the changes are uncommitted in the working tree. " +
			`A code review of these changes raised the ${noun} below. ` +
			`Your job is to address **${count === 1 ? "this finding" : "every listed finding"}**: fix it, or reject it with a concrete reason if it is not valid.`,
		"",
		"## Findings",
	];
	input.findings.forEach((finding, index) => lines.push("", ...formatFinding(finding, index + 1)));
	lines.push(
		"",
		"## Task context",
		"",
		"<task>",
		`# ${input.taskTitle}`,
		"",
		input.taskBody.trim(),
		"</task>",
	);
	if (input.prdId) {
		lines.push("", `If you need more context about the overall project, read the PRD todo: ${input.prdId}`);
	}
	lines.push(
		"",
		"## Instructions",
		"",
		"1. **Look at the uncommitted changes once** " +
			`(\`git status --porcelain --untracked-files=all -- . ':(exclude)${FIX_EXCLUDED_DIR}'\`, ` +
			`\`git diff HEAD -- . ':(exclude)${FIX_EXCLUDED_DIR}'\`; untracked files must be read directly).`,
		"2. **Verify each finding** against the referenced code and decide whether it is valid. Reviewers can be wrong.",
		"3. **Fix every valid finding** with the smallest correct change. Findings may touch the same code — handle them together, but report each one separately. Do not address issues that are not listed, do not refactor unrelated code and stay within the scope of the task.",
		"4. **Reject invalid findings** (false positive, contradicts the task or its acceptance criteria, already handled elsewhere, or the change would make the code worse) without changing code for them, with a concrete reason.",
		"5. **Run the relevant tests and checks once, after all fixes** (test suite, type check, build, lint — whatever the project uses) and make sure they pass. Do not run the full checks after each individual fix; quick targeted checks while working are fine. Add or adjust tests if a fix changes behavior. Report what you ran in `verification`.",
		"6. If a fix keeps breaking the checks and you cannot fix it properly, revert your own changes for that finding and reject it, explaining what blocks the fix.",
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
