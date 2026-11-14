import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendLogRecord, projectLogDir, pruneRunDirs, runDirName, runLogFileName, slugify, toLogRecord } from "./run-log.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prd-loop-pro-log-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-log.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
	});
});

describe("names", () => {
	it("builds file-system safe names", () => {
		assert.equal(slugify("/Users/me/Development/DK2"), "users-me-development-dk2");
		assert.equal(slugify("???"), "x");
		assert.equal(projectLogDir("/base", "/Users/me/DK2"), join("/base", "users-me-dk2"));
		assert.equal(runDirName(new Date("2026-11-13T22:30:50.123Z")), "2026-11-13T22-30-50");
		assert.equal(runLogFileName(4, "17a1/20", "Implement (attempt 2, retry)"), "004-17a1-20-implement-attempt-2-retry.jsonl");
		assert.equal(runLogFileName(12, "?/?", "Fix #1 • 3 findings"), "012-x-fix-1-3-findings.jsonl");
	});
});

describe("toLogRecord", () => {
	it("keeps completed messages and run-level events", () => {
		const message = { type: "message_end", message: { role: "assistant", content: [] } };
		assert.equal(toLogRecord(message), message);
		assert.deepEqual(toLogRecord({ type: "compaction_start", reason: "threshold" }), { type: "compaction_start", reason: "threshold" });
		assert.ok(toLogRecord({ type: "auto_retry_start", attempt: 1 }));
		assert.ok(toLogRecord({ type: "agent_settled", aborted: false }));
	});

	it("drops streaming deltas and the duplicate messages of agent_end", () => {
		assert.equal(toLogRecord({ type: "message_update", assistantMessageEvent: {} }), undefined);
		assert.equal(toLogRecord({ type: "tool_execution_update" }), undefined);
		assert.equal(toLogRecord("x"), undefined);
		assert.deepEqual(toLogRecord({ type: "agent_end", willRetry: false, messages: [1, 2] }), { type: "agent_end", willRetry: false });
	});
});

describe("appendLogRecord / pruneRunDirs", () => {
	it("appends JSON lines and creates the directory", () => {
		const file = join(dir, "run", "001-a.jsonl");
		appendLogRecord(file, { type: "run_start" });
		appendLogRecord(file, { type: "run_end", status: "completed" });
		const lines = readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines, [{ type: "run_start" }, { type: "run_end", status: "completed" }]);
	});

	it("never throws", () => {
		assert.doesNotThrow(() => appendLogRecord("/dev/null/x/y.jsonl", { type: "run_start" }));
		assert.doesNotThrow(() => pruneRunDirs(join(dir, "missing")));
	});

	it("keeps the newest run directories", () => {
		for (const name of ["2026-01-01T00-00-00", "2026-01-03T00-00-00", "2026-01-02T00-00-00"]) mkdirSync(join(dir, name));
		pruneRunDirs(dir, 2);
		assert.deepEqual(readdirSync(dir).sort(), ["2026-01-02T00-00-00", "2026-01-03T00-00-00"]);
		assert.equal(existsSync(join(dir, "2026-01-01T00-00-00")), false);
	});
});
