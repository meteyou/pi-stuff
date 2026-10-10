import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	EXECUTION_REPORT_HEADING,
	OPEN_FINDINGS_HEADING,
	appendSection,
	buildExecutionReport,
	buildOpenFindingsSection,
	formatCost,
	formatFindingHeadline,
	formatLocation,
	totalCost,
} from "./execution-report.ts";
import type { ExecutionRecord } from "./execution-report.ts";
import type { ReviewFinding } from "./subagent-result.ts";

const finding = (priority: ReviewFinding["priority"], title: string, extra: Partial<ReviewFinding> = {}): ReviewFinding => ({
	priority,
	title,
	file: "src/app.ts",
	line: 42,
	body: `Explanation for ${title}.`,
	...extra,
});

const emptyRecord = (): ExecutionRecord => ({
	implementerSummary: "Implemented the feature.",
	reviewRounds: 0,
	fixed: [],
	rejected: [],
	deferred: [],
	unresolved: [],
	callouts: [],
	commits: [],
	cost: {},
});

const fullRecord = (): ExecutionRecord => ({
	implementerSummary: "Added the review phase and the report module.",
	reviewRounds: 2,
	finalVerdict: "needs attention",
	reviewSummary: "Two issues remain.",
	fixed: [{ finding: finding("P1", "Null check missing"), summary: "Added a guard.", round: 1 }],
	rejected: [{ finding: finding("P2", "Use a map", { file: "src/util.ts", line: undefined }), reason: "Array is intentional for ordering.", round: 1 }],
	deferred: [finding("P3", "Rename variable")],
	unresolved: [{ finding: finding("P0", "Data loss on retry"), reason: "Not fixed (review-fix cycle not active)", round: 2 }],
	callouts: ["This change introduces a new dependency: left-pad", "This change introduces a new dependency: left-pad", "  "],
	commits: [
		{ sha: "abc1234", subject: "feat(review): add reviewer" },
		{ sha: "def5678" },
	],
	cost: { implement: 0.5, review: 0.25, commit: 0.05, repair: 0.001 },
});

function sectionContent(markdown: string, heading: string): string {
	const start = markdown.indexOf(`${heading}\n`);
	assert.notEqual(start, -1, `missing section ${heading}`);
	const rest = markdown.slice(start + heading.length + 1);
	const next = rest.search(/\n#{2,3} /);
	return (next === -1 ? rest : rest.slice(0, next)).trim();
}

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "execution-report.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
		assert.doesNotMatch(source, /from\s+["']@mariozechner\//);
	});
});

describe("buildExecutionReport — all sections", () => {
	const report = buildExecutionReport(fullRecord());

	it("starts with the Execution Report heading", () => {
		assert.ok(report.startsWith(`${EXECUTION_REPORT_HEADING}\n`));
	});

	it("contains the overview lines", () => {
		assert.match(report, /- \*\*Review:\*\* 2 rounds, final verdict: needs attention/);
		assert.match(report, /- \*\*Findings:\*\* 1 fixed, 1 rejected, 1 deferred, 1 unresolved/);
		assert.match(report, /- \*\*Commits:\*\* 2/);
	});

	it("contains total cost with per-phase breakdown", () => {
		assert.match(report, /- \*\*Cost:\*\* \$0\.80 \(implement \$0\.50, review \$0\.25, commit \$0\.05, JSON repair \$0\.0010\)/);
	});

	it("contains the implementer summary", () => {
		assert.equal(sectionContent(report, "### Implementer summary"), "Added the review phase and the report module.");
	});

	it("contains the review summary", () => {
		assert.equal(sectionContent(report, "### Review summary"), "Two issues remain.");
	});

	it("lists fixed findings with fix summary and round", () => {
		const content = sectionContent(report, "### Fixed findings");
		assert.match(content, /^- \*\*\[P1\]\*\* Null check missing — `src\/app\.ts:42`/);
		assert.match(content, /\*Round:\* 1/);
		assert.match(content, /\*Fix:\* Added a guard\./);
	});

	it("lists rejected findings with reasons", () => {
		const content = sectionContent(report, "### Rejected findings");
		assert.match(content, /^- \*\*\[P2\]\*\* Use a map — `src\/util\.ts`$/m);
		assert.match(content, /Explanation for Use a map\./);
		assert.match(content, /\*Reason:\* Array is intentional for ordering\./);
	});

	it("lists deferred findings", () => {
		const content = sectionContent(report, "### Deferred findings (below fix threshold)");
		assert.match(content, /\*\*\[P3\]\*\* Rename variable/);
		assert.match(content, /Explanation for Rename variable\./);
	});

	it("lists unresolved findings with status", () => {
		const content = sectionContent(report, "### Unresolved findings");
		assert.match(content, /\*\*\[P0\]\*\* Data loss on retry — `src\/app\.ts:42`/);
		assert.match(content, /\*Status:\* Not fixed \(review-fix cycle not active\)/);
		assert.match(content, /\*Round:\* 2/);
	});

	it("lists callouts deduplicated without empty entries", () => {
		const content = sectionContent(report, "### Human reviewer callouts");
		assert.equal(content, "- This change introduces a new dependency: left-pad");
	});

	it("lists commit SHAs with subjects", () => {
		const content = sectionContent(report, "### Commits");
		assert.equal(content, "- `abc1234` feat(review): add reviewer\n- `def5678`");
	});

	it("is deterministic", () => {
		assert.equal(buildExecutionReport(fullRecord()), report);
	});
});

describe("buildExecutionReport — empty lists", () => {
	const report = buildExecutionReport(emptyRecord());

	it("renders every list section with _None._", () => {
		for (const heading of [
			"### Fixed findings",
			"### Rejected findings",
			"### Deferred findings (below fix threshold)",
			"### Unresolved findings",
			"### Human reviewer callouts",
			"### Commits",
		]) {
			assert.equal(sectionContent(report, heading), "_None._", heading);
		}
	});

	it("shows zero rounds, zero counts and zero cost", () => {
		assert.match(report, /- \*\*Review:\*\* 0 rounds$/m);
		assert.match(report, /- \*\*Findings:\*\* 0 fixed, 0 rejected, 0 deferred, 0 unresolved/);
		assert.match(report, /- \*\*Commits:\*\* 0/);
		assert.match(report, /- \*\*Cost:\*\* \$0\.00$/m);
	});

	it("omits the review summary section when there is nothing to say", () => {
		assert.doesNotMatch(report, /### Review summary/);
	});

	it("renders a review note when the review was skipped", () => {
		const withNote = buildExecutionReport({ ...emptyRecord(), reviewNote: "No changes outside .pi/ — review skipped." });
		assert.equal(sectionContent(withNote, "### Review summary"), "_No changes outside .pi/ — review skipped._");
	});

	it("uses _None._ for an empty implementer summary", () => {
		const blank = buildExecutionReport({ ...emptyRecord(), implementerSummary: "  " });
		assert.equal(sectionContent(blank, "### Implementer summary"), "_None._");
	});

	it("uses singular for one round", () => {
		const one = buildExecutionReport({ ...emptyRecord(), reviewRounds: 1, finalVerdict: "correct" });
		assert.match(one, /- \*\*Review:\*\* 1 round, final verdict: correct/);
	});
});

describe("buildExecutionReport — formatting", () => {
	it("sorts findings by priority (stable)", () => {
		const report = buildExecutionReport({
			...emptyRecord(),
			unresolved: [
				{ finding: finding("P2", "second-a") },
				{ finding: finding("P0", "first") },
				{ finding: finding("P2", "second-b") },
			],
		});
		const content = sectionContent(report, "### Unresolved findings");
		const order = ["first", "second-a", "second-b"].map((t) => content.indexOf(t));
		assert.deepEqual([...order].sort((a, b) => a - b), order);
	});

	it("renders body and details as nested bullets, indenting multi-line bodies", () => {
		const report = buildExecutionReport({
			...emptyRecord(),
			deferred: [finding("P3", "Multi", { body: "Line one\n\nLine two" })],
			unresolved: [{ finding: finding("P1", "Open"), reason: "Still open", round: 1 }],
		});
		assert.match(report, /- \*\*\[P3\]\*\* Multi — `src\/app\.ts:42`\n  - Line one\n\n    Line two/);
		assert.match(
			report,
			/- \*\*\[P1\]\*\* Open — `src\/app\.ts:42`\n  - Explanation for Open\.\n  - \*Round:\* 1\n  - \*Status:\* Still open/,
		);
	});

	it("uses a placeholder for rejected findings without reason", () => {
		const report = buildExecutionReport({ ...emptyRecord(), rejected: [{ finding: finding("P1", "X"), reason: "" }] });
		assert.match(report, /\*Reason:\* \(no reason given\)/);
	});
});

describe("helpers", () => {
	it("formatLocation handles missing file and line", () => {
		assert.equal(formatLocation({ file: "a.ts", line: 3 }), "a.ts:3");
		assert.equal(formatLocation({ file: "a.ts" }), "a.ts");
		assert.equal(formatLocation({ file: "a.ts", line: 0 }), "a.ts");
		assert.equal(formatLocation({ file: "" }), "");
	});

	it("formatFindingHeadline omits empty location and collapses whitespace", () => {
		assert.equal(formatFindingHeadline(finding("P1", "Missing\n criterion", { file: "" })), "**[P1]** Missing criterion");
	});

	it("formatCost and totalCost", () => {
		assert.equal(formatCost(0), "$0.00");
		assert.equal(formatCost(1.234), "$1.23");
		assert.equal(formatCost(0.0042), "$0.0042");
		assert.equal(totalCost({ implement: 1, fix: 0.5 }), 1.5);
		assert.equal(totalCost({}), 0);
	});

	it("appendSection separates with one blank line", () => {
		assert.equal(appendSection("Body\n\n\n", "## Section\n"), "Body\n\n## Section");
		assert.equal(appendSection("", "## Section"), "## Section");
	});
});

describe("buildOpenFindingsSection", () => {
	it("lists open findings with body and status, and rejected with reasons", () => {
		const md = buildOpenFindingsSection(
			[{ finding: finding("P1", "Open one"), reason: "Round limit reached", round: 3 }],
			[{ finding: finding("P2", "Rejected one"), reason: "False positive" }],
		);
		assert.ok(md.startsWith(`${OPEN_FINDINGS_HEADING}\n`));
		const open = sectionContent(md, "### Open");
		assert.match(open, /\*\*\[P1\]\*\* Open one — `src\/app\.ts:42`/);
		assert.match(open, /Explanation for Open one\./);
		assert.match(open, /\*Status:\* Round limit reached/);
		const rejected = sectionContent(md, "### Rejected by fixer");
		assert.match(rejected, /\*Reason:\* False positive/);
	});

	it("states the release reason and the errors of the failed phase", () => {
		const md = buildOpenFindingsSection([], [], {
			reason: "git hook failed",
			errors: ["pre-commit: lint failed\nsrc/app.ts:1 unused var", "  "],
		});
		assert.match(md, /\*\*Released to a human:\*\* git hook failed/);
		assert.match(md, /re-run `\/prd-loop-pro`/);
		const errors = sectionContent(md, "### Errors");
		assert.match(errors, /^- pre-commit: lint failed\n {2}src\/app\.ts:1 unused var$/);
		assert.equal(sectionContent(md, "### Open"), "_None._");
	});

	it("omits release details when none are given", () => {
		const md = buildOpenFindingsSection([]);
		assert.doesNotMatch(md, /Released to a human/);
		assert.doesNotMatch(md, /### Errors/);
	});

	it("handles empty lists", () => {
		const md = buildOpenFindingsSection([]);
		assert.equal(sectionContent(md, "### Open"), "_None._");
		assert.doesNotMatch(md, /Rejected by fixer/);
		assert.match(md, /without open findings/);
	});
});
