import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	STATS_KEY,
	emptyStats,
	formatTokenCount,
	formatTokens,
	hasStats,
	parseStats,
	phaseCostsOf,
	serializeFrontMatter,
	sessionChoices,
	statsToJson,
	statsTotals,
	totalTokens,
} from "./task-stats.ts";
import type { RunRecord, TaskStats } from "./task-stats.ts";
import { defaultSessionDirName, findSessionFile, sessionDirsFor } from "./session-files.ts";
import { buildExecutionReport } from "./execution-report.ts";
import { buildTaskDetailLines } from "./progress-view.ts";

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
	phase: "implement",
	label: "Implement",
	session: "0193-aaaa",
	model: "anthropic/x · low",
	startedAt: "2026-11-14T10:00:00.000Z",
	durationMs: 600_000,
	cost: 1.25,
	tokens: { input: 1200, output: 3400, cacheRead: 2_000_000, cacheWrite: 50_000 },
	...overrides,
});

/** A run whose session was never stored (e.g. pi did not start). */
function withoutSession(record: RunRecord): RunRecord {
	const { session: _session, ...rest } = record;
	return rest;
}

const stats = (): TaskStats => ({
	activeMs: 754_000,
	runs: [
		run(),
		run({ phase: "review", label: "Review #1", session: "0193-bbbb", cost: 0.5, durationMs: 90_000, tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 } }),
		withoutSession(run({ phase: "implement", label: "Implement (attempt 2)", cost: 0.25, failed: true })),
	],
	review: { round: 1, roundLimit: 5, fixed: 2, rejected: 0, deferred: 1, unresolved: 0, verdict: "correct", callouts: 3 },
});

describe("module purity", () => {
	it("has no pi imports", () => {
		for (const file of ["task-stats.ts", "session-files.ts"]) {
			const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf-8");
			assert.doesNotMatch(source, /from\s+["']@earendil-works\//, file);
		}
	});
});

describe("totals", () => {
	it("sums cost, tokens and runs", () => {
		const totals = statsTotals(stats());
		assert.equal(totals.cost, 2);
		assert.equal(totals.runs, 3);
		assert.deepEqual(totals.tokens, { input: 2500, output: 7000, cacheRead: 4_000_000, cacheWrite: 100_000 });
		assert.equal(totalTokens(totals.tokens), 4_109_500);
	});

	it("groups cost by phase", () => {
		assert.deepEqual(phaseCostsOf(stats()), { implement: 1.5, review: 0.5 });
		assert.deepEqual(phaseCostsOf(emptyStats()), {});
	});

	it("knows whether there is anything stored", () => {
		assert.equal(hasStats(emptyStats()), false);
		assert.equal(hasStats(stats()), true);
	});
});

describe("formatting", () => {
	it("formats token counts compactly", () => {
		assert.equal(formatTokenCount(0), "0");
		assert.equal(formatTokenCount(950), "950");
		assert.equal(formatTokenCount(12_340), "12.3k");
		assert.equal(formatTokenCount(999_960), "1.00M");
		assert.equal(formatTokenCount(4_560_000), "4.56M");
		assert.equal(formatTokenCount(Number.NaN), "0");
	});

	it("leaves out zero parts", () => {
		assert.equal(formatTokens({ input: 1200, output: 3400, cacheRead: 2_000_000, cacheWrite: 0 }), "1.2k in • 3.4k out • 2.00M cache read");
		assert.equal(formatTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), "0");
	});
});

describe("statsToJson / parseStats", () => {
	it("round-trips", () => {
		assert.deepEqual(parseStats(statsToJson(stats())), stats());
		assert.deepEqual(parseStats(JSON.parse(JSON.stringify(statsToJson(stats())))), stats());
	});

	it("uses snake_case keys like the rest of the front matter", () => {
		const json = statsToJson(stats()) as any;
		assert.equal(json.version, 1);
		assert.equal(json.active_ms, 754_000);
		assert.deepEqual(Object.keys(json.runs[0]), ["phase", "label", "session", "model", "started_at", "duration_ms", "cost", "tokens"]);
		assert.deepEqual(json.runs[0].tokens, { input: 1200, output: 3400, cache_read: 2_000_000, cache_write: 50_000 });
		assert.equal(json.runs[2].failed, true);
		assert.equal("session" in json.runs[2], false);
	});

	it("never stores braces or control characters (the front matter end is found by counting braces)", () => {
		const json = JSON.stringify(statsToJson({ activeMs: 1, runs: [run({ label: "Fix {x}\n}}", model: "m{" })] }));
		assert.equal(json.split("{").length, json.split("}").length);
		assert.doesNotMatch(json, /Fix \{|\\n/);
	});

	it("is tolerant: unusable input gives empty statistics, unusable parts are dropped", () => {
		for (const value of [undefined, null, "x", 3, []]) assert.deepEqual(parseStats(value), emptyStats());
		const parsed = parseStats({
			active_ms: -5,
			runs: [
				{ phase: "implement", cost: "a", duration_ms: 10 },
				{ phase: "unknown-phase", cost: 1 },
				"x",
			],
			review: { round: 0 },
		});
		assert.equal(parsed.activeMs, 0);
		assert.equal(parsed.runs.length, 1);
		assert.deepEqual(parsed.runs[0], {
			phase: "implement",
			label: "implement",
			startedAt: "",
			durationMs: 10,
			cost: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		assert.equal(parsed.review, undefined);
	});
});

describe("serializeFrontMatter", () => {
	it("pretty-prints the usual fields and keeps the statistics on one line", () => {
		const text = serializeFrontMatter({ id: "abc", title: "T {1}", tags: ["task"], status: "open", [STATS_KEY]: statsToJson(stats()) });
		const lines = text.split("\n");
		assert.equal(lines[0], "{");
		assert.equal(lines[1], '  "id": "abc",');
		assert.match(lines.at(-2)!, /^ {2}"prd_loop": \{"version":1,"active_ms":754000,"runs":\[.*\}$/);
		assert.equal(lines.at(-1), "}");
		// {, id, title, tags (3 lines), status, prd_loop, }
		assert.equal(lines.length, 9);
		assert.deepEqual(parseStats(JSON.parse(text)[STATS_KEY]), stats());
		assert.equal(JSON.parse(text).title, "T {1}");
	});

	it("is plain pretty JSON without statistics", () => {
		const meta = { id: "abc", tags: [] };
		assert.equal(serializeFrontMatter(meta), JSON.stringify(meta, null, 2));
	});
});

describe("sessionChoices", () => {
	it("lists the runs that have a session, oldest first", () => {
		const choices = sessionChoices(stats(), { duration: (ms) => `${ms / 1000}s` });
		assert.deepEqual(choices, [
			{ session: "0193-aaaa", label: "1. Implement — 600s • $1.25 • anthropic/x · low • 2026-11-14 10:00 UTC" },
			{ session: "0193-bbbb", label: "2. Review #1 — 90s • $0.50 • anthropic/x · low • 2026-11-14 10:00 UTC" },
		]);
	});

	it("marks failed runs and uses the given time format", () => {
		const choices = sessionChoices({ activeMs: 0, runs: [run({ failed: true })] }, { duration: () => "10:00", time: () => "today" });
		assert.equal(choices[0]!.label, "1. Implement ✗ — 10:00 • $1.25 • anthropic/x · low • today");
	});
});

describe("session files", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prd-loop-pro-sessions-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("names the default session directory like pi", () => {
		assert.equal(defaultSessionDirName("/Users/me/Development/DK2"), "--Users-me-Development-DK2--");
	});

	it("lists the directory of the current session and the default one, without duplicates", () => {
		assert.deepEqual(sessionDirsFor("/p/x", "/agent", "/custom"), ["/custom", join("/agent", "sessions", "--p-x--")]);
		assert.deepEqual(sessionDirsFor("/p/x", "/agent", ""), [join("/agent", "sessions", "--p-x--")]);
		assert.deepEqual(sessionDirsFor("/p/x", "/agent", join("/agent", "sessions", "--p-x--")), [join("/agent", "sessions", "--p-x--")]);
	});

	it("finds a session file by id", () => {
		writeFileSync(join(dir, "2026-11-14T10-00-00-000Z_0193-aaaa.jsonl"), "{}\n");
		writeFileSync(join(dir, "2026-11-14T10-00-00-000Z_0193-aaaa-other.jsonl"), "{}\n");
		assert.equal(findSessionFile(["", join(dir, "missing"), dir], "0193-aaaa"), join(dir, "2026-11-14T10-00-00-000Z_0193-aaaa.jsonl"));
		assert.equal(findSessionFile([dir], "0193-cccc"), null);
	});
});

describe("report and task details", () => {
	const record = {
		implementerSummary: "done",
		reviewRounds: 0,
		fixed: [],
		rejected: [],
		deferred: [],
		unresolved: [],
		callouts: [],
		commits: [],
		cost: { implement: 1.5 },
	};

	it("adds time, tokens and sessions to the execution report when given", () => {
		const report = buildExecutionReport({
			...record,
			time: "12:34",
			tokens: "1.2k in • 3.4k out",
			sessions: [{ id: "0193-aaaa", label: "Implement", model: "anthropic/x · low" }, { id: "0193-bbbb", label: "Review #1" }],
		});
		assert.match(report, /^- \*\*Time:\*\* 12:34 \(active, without time spent in dialogs\)$/m);
		assert.match(report, /^- \*\*Tokens:\*\* 1\.2k in • 3\.4k out$/m);
		assert.match(report, /### Sessions\n\nOpen one with `pi --session <id>` or with the \*sessions\* action of this todo in `\/todos`\.\n\n- `0193-aaaa` Implement — anthropic\/x · low\n- `0193-bbbb` Review #1$/);
	});

	it("leaves the report unchanged without them", () => {
		const report = buildExecutionReport(record);
		assert.doesNotMatch(report, /Time:|Tokens:|### Sessions/);
	});

	it("shows the tokens in the task details", () => {
		assert.deepEqual(buildTaskDetailLines({ tokens: "1.2k in" }), [{ label: "Tokens", text: "1.2k in" }]);
		assert.deepEqual(buildTaskDetailLines({}), []);
	});
});
