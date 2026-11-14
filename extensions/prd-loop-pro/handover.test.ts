import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HANDOVER_MAX_ERRORS, HANDOVER_MAX_TEXT_LENGTH, buildHandoverPrompt } from "./handover.ts";
import type { HandoverInfo } from "./handover.ts";
import { buildSplitterPrompt } from "./splitter-prompt.ts";

const info = (overrides: Partial<HandoverInfo> = {}): HandoverInfo => ({
	taskId: "TODO-6f93b98b",
	taskTitle: "PRD #1 - Task 17a/20: Engine allocator",
	prdId: "TODO-d6d75bc1",
	prdTitle: "PRD #1: Foundation",
	phase: "Implement",
	reason: "implementation failed after 2 attempts",
	...overrides,
});

describe("module purity", () => {
	it("has no pi imports", () => {
		for (const file of ["handover.ts", "splitter-prompt.ts"]) {
			const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf-8");
			assert.doesNotMatch(source, /from\s+["']@earendil-works\//, file);
		}
	});
});

describe("buildHandoverPrompt", () => {
	it("names the task, the PRD, the phase and the reason, and asks to investigate first", () => {
		const prompt = buildHandoverPrompt(info());
		assert.match(prompt, /^The PRD loop \(\/prd-loop-pro\) stopped at a task/);
		assert.match(prompt, /^- Task: TODO-6f93b98b "PRD #1 - Task 17a\/20: Engine allocator" \(status: needs-human\)$/m);
		assert.match(prompt, /^- PRD: TODO-d6d75bc1 "PRD #1: Foundation"$/m);
		assert.match(prompt, /^- Phase: Implement$/m);
		assert.match(prompt, /^- Reason: implementation failed after 2 attempts$/m);
		assert.match(prompt, /Do not change anything before I agree/);
		assert.match(prompt, /Splitting an existing task into subtasks/);
		assert.match(prompt, /re-open it if it was split or rewritten/);
		assert.doesNotMatch(prompt, /Errors:|Subagent logs|Split proposed|open review finding/);
	});

	it("includes errors (capped), summary, proposed split, findings and logs", () => {
		const prompt = buildHandoverPrompt(info({
			errors: Array.from({ length: HANDOVER_MAX_ERRORS + 2 }, (_, i) => `error ${i}\nline 2`),
			summary: "y".repeat(HANDOVER_MAX_TEXT_LENGTH + 100),
			proposedSplit: [{ title: "Allocator", description: "6 functions" }, { title: "Surfaces", description: "" }],
			openFindings: 2,
			logFiles: ["/logs/001.jsonl"],
		}));
		assert.match(prompt, /^ {2}- error 0 line 2$/m);
		assert.match(prompt, /^ {2}- … and 2 more \(see the todo\)$/m);
		assert.doesNotMatch(prompt, new RegExp(`y{${HANDOVER_MAX_TEXT_LENGTH}}`));
		assert.match(prompt, /^ {2}1\. Allocator — 6 functions$/m);
		assert.match(prompt, /^ {2}2\. Surfaces$/m);
		assert.match(prompt, /^- 2 open review findings/m);
		assert.match(prompt, /^ {2}- \/logs\/001\.jsonl$/m);
	});
});

describe("buildSplitterPrompt", () => {
	const base = {
		taskTitle: "PRD #1 - Task 17a/20: Engine allocator",
		taskBody: "## What to build\n\nPort 160 functions.\n\n## Acceptance criteria\n\n- [ ] all ported",
		prdId: "TODO-d6d75bc1",
		reason: "implementation failed after 2 attempts",
		hasChanges: true,
	};

	it("contains the task, the reason and where the changes are", () => {
		const prompt = buildSplitterPrompt(base);
		assert.match(prompt, /^# Split this task: PRD #1 - Task 17a\/20: Engine allocator$/m);
		assert.match(prompt, /^- Reason: implementation failed after 2 attempts$/m);
		assert.match(prompt, /uncommitted changes of the attempt are on disk/);
		assert.match(prompt, /Port 160 functions\./);
		assert.match(prompt, /read the PRD todo: TODO-d6d75bc1 \(file `\.pi\/todos\/d6d75bc1\.md`\)/);
		assert.doesNotMatch(prompt, /previous proposal|reported the task as blocked/);
	});

	it("passes on what the implementer reported and the issues of a previous proposal", () => {
		const prompt = buildSplitterPrompt({
			...base,
			hasChanges: false,
			errors: ["tests failed"],
			summary: "Got to 40 functions.",
			blockedReason: "160 functions, limit is 60",
			proposedSplit: [{ title: "Allocator", description: "6 functions" }],
			previousIssues: ["subtask 2 depends on 3; only earlier subtasks (1…1) are allowed"],
		});
		assert.match(prompt, /^ {2}- tests failed$/m);
		assert.match(prompt, /^- Implementer summary: Got to 40 functions\.$/m);
		assert.match(prompt, /^- The implementer reported the task as blocked: 160 functions, limit is 60$/m);
		assert.match(prompt, /^1\. Allocator — 6 functions$/m);
		assert.match(prompt, /The attempt left no uncommitted changes\./);
		assert.match(prompt, /^- subtask 2 depends on 3/m);
	});
});
