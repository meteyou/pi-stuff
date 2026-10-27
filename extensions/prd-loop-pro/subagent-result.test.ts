import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	COMMITTER_RESULT_SCHEMA,
	FIXER_RESULT_SCHEMA,
	REPAIR_SYSTEM_PROMPT,
	REVIEWER_RESULT_SCHEMA,
	WORKER_RESULT_SCHEMA,
	buildRepairPrompt,
	describeSchema,
	extractJsonObjects,
	parseSubagentResult,
	rawSnippet,
	repairJsonText,
	stripCodeFences,
	validateResult,
} from "./subagent-result.ts";
import type { RepairRequest } from "./subagent-result.ts";

const VALID_WORKER = '{"success": true, "errors": [], "summary": "Implemented the thing"}';

function noRepair(): never {
	throw new Error("repair must not be called");
}

describe("module purity", () => {
	it("has no pi imports", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "subagent-result.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["']@earendil-works\//);
		assert.doesNotMatch(source, /from\s+["']@mariozechner\//);
	});
});

describe("parseSubagentResult — deterministic extraction", () => {
	it("parses plain JSON directly", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, VALID_WORKER, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.method, "direct");
		assert.deepEqual(outcome.value, { success: true, errors: [], summary: "Implemented the thing" });
	});

	it("strips ```json code fences", async () => {
		const text = "```json\n" + VALID_WORKER + "\n```";
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.method, "deterministic-repair");
		assert.equal(outcome.value.summary, "Implemented the thing");
	});

	it("strips bare ``` fences without trailing newline", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, "```\n" + VALID_WORKER + "```", { repair: noRepair });
		assert.equal(outcome.ok, true);
	});

	it("ignores prose before and after the JSON", async () => {
		const text = `All done! Here is my result:\n\n${VALID_WORKER}\n\nLet me know if you need anything else {really}.`;
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.success, true);
	});

	it("handles unbalanced braces in prose before the JSON", async () => {
		const text = `I fixed the stray \`{\` in the parser.\n${VALID_WORKER}`;
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
	});

	it("removes trailing commas", async () => {
		const text = '{\n  "success": false,\n  "errors": ["test failed",],\n  "summary": "Tests broke",\n}';
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.method, "deterministic-repair");
		assert.deepEqual(outcome.value, { success: false, errors: ["test failed"], summary: "Tests broke" });
	});

	it("does not touch commas inside strings", async () => {
		const text = '{"success": true, "errors": [], "summary": "a, }b ,]c",}';
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.summary, "a, }b ,]c");
	});

	it("escapes raw newlines inside strings", async () => {
		const text = '{"success": true, "errors": [], "summary": "line one\nline two"}';
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.summary, "line one\nline two");
	});

	it("takes the last JSON object when several are present", async () => {
		const text = [
			"First attempt:",
			'{"success": false, "errors": ["draft"], "summary": "draft"}',
			"Final:",
			"```json",
			'{"success": true, "errors": [], "summary": "final"}',
			"```",
		].join("\n");
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.summary, "final");
		assert.equal(outcome.value.success, true);
	});

	it("prefers the last object that matches the schema", async () => {
		const text = `${VALID_WORKER}\nExample config I used: {"timeout": 10}`;
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, text, { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.value.summary, "Implemented the thing");
	});

	it("does not treat nested objects as separate results", () => {
		const objects = extractJsonObjects('x {"a": {"b": 1}, "c": [{"d": 2}]} y {"e": 3}');
		assert.deepEqual(objects.map((o) => o.value), [{ a: { b: 1 }, c: [{ d: 2 }] }, { e: 3 }]);
	});

	it("applies defaults for optional fields and drops unknown fields", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, '{"success": true, "extra": 1}', { repair: noRepair });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.deepEqual(outcome.value, { success: true, errors: [], summary: "" });
	});
});

describe("parseSubagentResult — schema violations", () => {
	it("reports a wrong type without repair function", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, '{"success": "yes", "errors": [], "summary": "x"}');
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.kind, "schema");
		assert.equal(outcome.repairAttempted, false);
		assert.ok(outcome.issues.some((i) => i.includes("$.success") && i.includes("expected boolean")));
	});

	it("reports a missing required property", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, '{"errors": [], "summary": "x"}');
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.ok(outcome.issues.some((i) => i.includes("$.success") && i.includes("missing")));
	});

	it("reports wrong array item types with index paths", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, '{"success": false, "errors": ["ok", 42]}');
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.ok(outcome.issues.some((i) => i.startsWith("$.errors[1]")));
	});

	it("reports missing JSON", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, "I finished the task successfully.");
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.kind, "no-json");
	});

	it("reports empty output without calling repair", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, "   \n", { repair: noRepair });
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.kind, "empty");
		assert.equal(outcome.repairAttempted, false);
		assert.match(outcome.message, /no output/);
	});

	it("validates reviewer enums, nested findings and optional line", () => {
		const ok = validateResult(REVIEWER_RESULT_SCHEMA, {
			verdict: "needs attention",
			summary: "s",
			findings: [{ priority: "P1", title: "t", file: "a.ts", line: null, body: "b" }],
		});
		assert.equal(ok.ok, true);
		if (ok.ok) {
			assert.deepEqual(ok.value.findings[0], { priority: "P1", title: "t", file: "a.ts", body: "b" });
			assert.deepEqual(ok.value.callouts, []);
		}

		const bad = validateResult(REVIEWER_RESULT_SCHEMA, {
			verdict: "maybe",
			findings: [{ priority: "P4", title: "t", file: "a.ts", body: "b", line: 1.5 }],
		});
		assert.equal(bad.ok, false);
		if (!bad.ok) {
			const paths = bad.issues.map((i) => i.path);
			assert.deepEqual(paths, ["$.verdict", "$.findings[0].priority", "$.findings[0].line"]);
		}
	});

	it("validates fixer and committer schemas", () => {
		const fixer = validateResult(FIXER_RESULT_SCHEMA, { results: [{ id: 1, status: "rejected", reason: "false positive" }] });
		assert.equal(fixer.ok, true);
		if (fixer.ok) assert.deepEqual(fixer.value, { results: [{ id: 1, status: "rejected", reason: "false positive", summary: "" }], verification: "" });
		assert.equal(validateResult(FIXER_RESULT_SCHEMA, { status: "rejected", reason: "single-finding format" }).ok, false);
		const badFixer = validateResult(FIXER_RESULT_SCHEMA, { results: [{ id: 0, status: "done" }] });
		assert.equal(badFixer.ok, false);
		if (!badFixer.ok) assert.deepEqual(badFixer.issues.map((i) => i.path), ["$.results[0].id", "$.results[0].status"]);
		const committer = validateResult(COMMITTER_RESULT_SCHEMA, { success: true, summary: "2 commits" });
		assert.equal(committer.ok, true);
		if (committer.ok) assert.equal(committer.value.hookFailed, false);
	});
});

describe("parseSubagentResult — LLM repair", () => {
	const broken = 'Done. {"success": true, "errors": [], "summary": "unescaped "quotes" here"}';

	it("calls repair once with schema and raw text, and accepts a valid answer", async () => {
		const requests: RepairRequest[] = [];
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, broken, {
			repair: async (request) => {
				requests.push(request);
				return '```json\n{"success": true, "errors": [], "summary": "unescaped \\"quotes\\" here"}\n```';
			},
		});
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.agent, "prd-worker");
		assert.equal(requests[0]!.systemPrompt, REPAIR_SYSTEM_PROMPT);
		assert.ok(requests[0]!.prompt.includes(describeSchema(WORKER_RESULT_SCHEMA)));
		assert.ok(requests[0]!.prompt.includes(broken));
		assert.match(requests[0]!.prompt, /JSON only/);

		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.method, "llm-repair");
		assert.equal(outcome.value.summary, 'unescaped "quotes" here');
	});

	it("does not call repair when deterministic parsing succeeds", async () => {
		let calls = 0;
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, VALID_WORKER + ",", {
			repair: async () => {
				calls++;
				return VALID_WORKER;
			},
		});
		assert.equal(outcome.ok, true);
		assert.equal(calls, 0);
	});

	it("fails when the repaired answer is still invalid (no second attempt)", async () => {
		let calls = 0;
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, broken, {
			repair: async () => {
				calls++;
				return '{"success": "maybe"}';
			},
		});
		assert.equal(calls, 1);
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.repairAttempted, true);
		assert.equal(outcome.repairError, undefined);
		assert.ok(outcome.issues.some((i) => i.startsWith("after repair:") && i.includes("$.success")));
		assert.match(outcome.message, /LLM repair did not produce a valid result/);
		assert.ok(outcome.message.includes("unescaped"), "message contains a raw output snippet");
	});

	it("fails with repair-error when the repair function throws", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, broken, {
			repair: async () => {
				throw new Error("model unavailable");
			},
		});
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.equal(outcome.kind, "repair-error");
		assert.equal(outcome.repairAttempted, true);
		assert.equal(outcome.repairError, "model unavailable");
		assert.match(outcome.message, /model unavailable/);
		assert.match(outcome.message, /raw output: ".*quotes.*"/);
	});

	it("repairs schema violations, not only syntax errors", async () => {
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, '{"status": "success", "summary": "did it"}', {
			repair: async () => '{"success": true, "errors": [], "summary": "did it"}',
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.method, "llm-repair");
	});
});

describe("failure message and snippet", () => {
	it("includes a tail snippet of the raw output", async () => {
		const longProse = `${"lorem ipsum ".repeat(100)}THE END`;
		const outcome = await parseSubagentResult(WORKER_RESULT_SCHEMA, longProse);
		assert.equal(outcome.ok, false);
		if (outcome.ok) return;
		assert.match(outcome.message, /^Failed to parse result: prd-worker did not return a JSON result/);
		assert.ok(outcome.rawSnippet.endsWith("THE END"));
		assert.ok(outcome.rawSnippet.startsWith("…"));
		assert.ok(outcome.rawSnippet.length <= 300);
		assert.ok(outcome.message.includes(outcome.rawSnippet));
	});

	it("collapses whitespace in snippets", () => {
		assert.equal(rawSnippet("a\n\n  b\tc"), "a b c");
		assert.equal(rawSnippet(""), "(empty output)");
		assert.equal(rawSnippet("abcdefghij", 5), "…ghij");
	});
});

describe("helpers", () => {
	it("stripCodeFences removes fence lines only", () => {
		assert.equal(stripCodeFences("a\n```json\n{}\n```\nb"), "a\n\n{}\n\nb");
	});

	it("repairJsonText removes trailing commas before } and ]", () => {
		assert.equal(repairJsonText('{"a": [1, 2, ], }'), '{"a": [1, 2 ] }');
	});

	it("describeSchema renders optional markers, enums and nested arrays", () => {
		const description = describeSchema(REVIEWER_RESULT_SCHEMA);
		assert.match(description, /"verdict": "correct" \| "needs attention"/);
		assert.match(description, /"findings"\?: Array<\{/);
		assert.match(description, /"line"\?: integer/);
		assert.match(description, /"callouts"\?: string\[\]/);
	});

	it("buildRepairPrompt truncates very long raw output from the front", () => {
		const raw = `${"x".repeat(30000)}TAIL`;
		const prompt = buildRepairPrompt(WORKER_RESULT_SCHEMA, raw, ["no JSON object found in output"]);
		assert.ok(prompt.includes("TAIL"));
		assert.ok(prompt.includes("(truncated)"));
		assert.ok(prompt.length < 25000);
	});
});
