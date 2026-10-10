/**
 * PRD Loop Pro — Subagent result parsing (pure, no pi imports).
 *
 * Every subagent ends its run with a JSON object as final message. Models
 * occasionally wrap it in code fences, add prose around it, emit trailing
 * commas or several JSON objects. This module turns the raw final text into a
 * typed, schema-validated result:
 *
 * 1. Deterministic extraction: strip code fences, find all balanced top-level
 *    JSON objects, repair common slips (trailing commas, raw control characters
 *    inside strings) and validate against the per-agent schema. When several
 *    objects are present the last valid one wins.
 * 2. LLM repair (injected): if deterministic extraction fails, the injected
 *    repair function is called once with a prompt containing the expected
 *    schema and the raw text. Its answer goes through step 1 again.
 * 3. Typed outcome: `{ ok: true, value }` or `{ ok: false, ... }` with a clear
 *    message and a snippet of the raw output.
 *
 * Intentionally free of pi imports so it can be unit-tested with `node --test`
 * (native TypeScript type stripping). Only erasable TypeScript syntax is used.
 */

// --- Schema ---

/** Minimal JSON schema description used for validation and the repair prompt. */
export type SchemaNode =
	| { type: "string"; enum?: readonly string[]; description?: string }
	| { type: "boolean"; description?: string }
	| { type: "number"; integer?: boolean; min?: number; description?: string }
	| { type: "array"; items: SchemaNode; description?: string }
	| ObjectSchema;

export interface ObjectSchema {
	type: "object";
	properties: Record<string, PropertySchema>;
	description?: string;
}

/** Property of an object schema. Optional properties may define a default. */
export type PropertySchema = SchemaNode & { optional?: boolean; default?: unknown };

/** Schema of one agent's final result. */
export interface ResultSchema<T> {
	/** Agent name, used in messages and the repair prompt (e.g. "prd-worker"). */
	name: string;
	schema: ObjectSchema;
	/** Phantom field carrying the result type (never set at runtime). */
	readonly __type?: T;
}

/** Validation issue with a JSON path (e.g. `$.findings[0].priority`). */
export interface ValidationIssue {
	path: string;
	message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function cloneDefault(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateNode(node: SchemaNode, value: unknown, path: string, issues: ValidationIssue[]): unknown {
	switch (node.type) {
		case "string":
			if (typeof value !== "string") {
				issues.push({ path, message: `expected string, got ${describeValue(value)}` });
				return undefined;
			}
			if (node.enum && !node.enum.includes(value)) {
				issues.push({ path, message: `expected one of ${node.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}` });
				return undefined;
			}
			return value;
		case "boolean":
			if (typeof value !== "boolean") {
				issues.push({ path, message: `expected boolean, got ${describeValue(value)}` });
				return undefined;
			}
			return value;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) {
				issues.push({ path, message: `expected number, got ${describeValue(value)}` });
				return undefined;
			}
			if (node.integer && !Number.isInteger(value)) {
				issues.push({ path, message: `expected integer, got ${value}` });
				return undefined;
			}
			if (node.min !== undefined && value < node.min) {
				issues.push({ path, message: `expected number ≥ ${node.min}, got ${value}` });
				return undefined;
			}
			return value;
		case "array": {
			if (!Array.isArray(value)) {
				issues.push({ path, message: `expected array, got ${describeValue(value)}` });
				return undefined;
			}
			return value.map((item, index) => validateNode(node.items, item, `${path}[${index}]`, issues));
		}
		case "object": {
			if (!isPlainObject(value)) {
				issues.push({ path, message: `expected object, got ${describeValue(value)}` });
				return undefined;
			}
			const out: Record<string, unknown> = {};
			for (const [key, prop] of Object.entries(node.properties)) {
				const propPath = `${path}.${key}`;
				const propValue = value[key];
				if (propValue === undefined || (propValue === null && prop.optional)) {
					if (prop.optional) {
						if (prop.default !== undefined) out[key] = cloneDefault(prop.default);
						continue;
					}
					issues.push({ path: propPath, message: "missing required property" });
					continue;
				}
				const validated = validateNode(prop, propValue, propPath, issues);
				if (validated !== undefined) out[key] = validated;
			}
			// Unknown properties are ignored (agents may add extra context).
			return out;
		}
	}
}

/**
 * Validate a parsed JSON value against a result schema. Returns the normalized
 * value (defaults applied, unknown properties dropped) or the list of issues.
 */
export function validateResult<T>(schema: ResultSchema<T>, value: unknown): ValidationResult<T> {
	const issues: ValidationIssue[] = [];
	const normalized = validateNode(schema.schema, value, "$", issues);
	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, value: normalized as T };
}

function describeNode(node: SchemaNode, indent: string): string {
	switch (node.type) {
		case "string":
			return node.enum ? node.enum.map((v) => JSON.stringify(v)).join(" | ") : "string";
		case "boolean":
			return "boolean";
		case "number":
			return node.integer ? "integer" : "number";
		case "array": {
			const inner = describeNode(node.items, indent);
			return node.items.type === "object" ? `Array<${inner}>` : `${inner}[]`;
		}
		case "object": {
			const innerIndent = `${indent}  `;
			const lines = Object.entries(node.properties).map(([key, prop]) => {
				const optional = prop.optional ? "?" : "";
				const comment = prop.description ? ` // ${prop.description}` : "";
				return `${innerIndent}${JSON.stringify(key)}${optional}: ${describeNode(prop, innerIndent)},${comment}`;
			});
			return `{\n${lines.join("\n")}\n${indent}}`;
		}
	}
}

/**
 * Human/LLM-readable description of a schema (TypeScript-like notation,
 * `?` marks optional properties).
 */
export function describeSchema(schema: ResultSchema<unknown>): string {
	return describeNode(schema.schema, "");
}

// --- Agent result schemas ---

export interface WorkerResult {
	success: boolean;
	errors: string[];
	summary: string;
}

/** prd-worker: `{ success, errors[], summary }` (unchanged contract). */
export const WORKER_RESULT_SCHEMA: ResultSchema<WorkerResult> = {
	name: "prd-worker",
	schema: {
		type: "object",
		properties: {
			success: { type: "boolean", description: "true only if all acceptance criteria are met and checks pass" },
			errors: { type: "array", items: { type: "string" }, optional: true, default: [] },
			summary: { type: "string", optional: true, default: "" },
		},
	},
};

export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export interface ReviewFinding {
	priority: FindingPriority;
	title: string;
	file: string;
	line?: number;
	body: string;
}

export interface ReviewerResult {
	verdict: "correct" | "needs attention";
	summary: string;
	findings: ReviewFinding[];
	callouts: string[];
}

/** prd-reviewer: `{ verdict, summary, findings[], callouts[] }`. */
export const REVIEWER_RESULT_SCHEMA: ResultSchema<ReviewerResult> = {
	name: "prd-reviewer",
	schema: {
		type: "object",
		properties: {
			verdict: { type: "string", enum: ["correct", "needs attention"] },
			summary: { type: "string", optional: true, default: "" },
			findings: {
				type: "array",
				optional: true,
				default: [],
				items: {
					type: "object",
					properties: {
						priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
						title: { type: "string" },
						file: { type: "string" },
						line: { type: "number", integer: true, min: 0, optional: true },
						body: { type: "string" },
					},
				},
			},
			callouts: { type: "array", items: { type: "string" }, optional: true, default: [] },
		},
	},
};

export interface FixerResult {
	status: "fixed" | "rejected";
	reason: string;
	summary: string;
	verification: string;
}

/** prd-fixer: `{ status, reason, summary, verification }`. */
export const FIXER_RESULT_SCHEMA: ResultSchema<FixerResult> = {
	name: "prd-fixer",
	schema: {
		type: "object",
		properties: {
			status: { type: "string", enum: ["fixed", "rejected"] },
			reason: { type: "string", optional: true, default: "" },
			summary: { type: "string", optional: true, default: "" },
			verification: { type: "string", optional: true, default: "" },
		},
	},
};

export interface CommitterResult {
	success: boolean;
	errors: string[];
	summary: string;
	hookFailed: boolean;
}

/** prd-committer: `{ success, errors[], summary, hookFailed }`. */
export const COMMITTER_RESULT_SCHEMA: ResultSchema<CommitterResult> = {
	name: "prd-committer",
	schema: {
		type: "object",
		properties: {
			success: { type: "boolean" },
			errors: { type: "array", items: { type: "string" }, optional: true, default: [] },
			summary: { type: "string", optional: true, default: "" },
			hookFailed: { type: "boolean", optional: true, default: false },
		},
	},
};

// --- Deterministic extraction ---

/** Remove markdown code fence marker lines (```json, ```), keeping their content. */
export function stripCodeFences(text: string): string {
	return text.replace(/^[ \t]*(```|~~~)[^\n]*$/gm, "");
}

/**
 * Find the end index (inclusive) of the balanced `{...}` starting at `start`,
 * respecting JSON strings. Returns -1 if unbalanced.
 */
function findObjectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return ch === "}" ? i : -1;
			if (depth < 0) return -1;
		}
	}
	return -1;
}

/**
 * Remove trailing commas before `}` / `]` and escape raw control characters
 * inside strings (both are common LLM slips that make JSON.parse fail).
 */
export function repairJsonText(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) {
				escaped = false;
				out += ch;
			} else if (ch === "\\") {
				escaped = true;
				out += ch;
			} else if (ch === '"') {
				inString = false;
				out += ch;
			} else if (ch === "\n") out += "\\n";
			else if (ch === "\r") out += "\\r";
			else if (ch === "\t") out += "\\t";
			else if (ch.charCodeAt(0) < 0x20) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
			else out += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j]!)) j++;
			if (text[j] === "}" || text[j] === "]") continue; // drop trailing comma
		}
		out += ch;
	}
	return out;
}

function tryParseJson(text: string): { ok: true; value: unknown; repaired: boolean } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text), repaired: false };
	} catch {
		// fall through to repair
	}
	const repairedText = repairJsonText(text);
	if (repairedText !== text) {
		try {
			return { ok: true, value: JSON.parse(repairedText), repaired: true };
		} catch {
			// not parseable
		}
	}
	return { ok: false };
}

/**
 * Extract all top-level JSON objects from free text (in order of appearance).
 * Code fences are stripped, prose before/after/between objects is ignored,
 * trailing commas and raw control characters in strings are repaired.
 */
export function extractJsonObjects(text: string): Array<{ value: Record<string, unknown>; repaired: boolean }> {
	const source = stripCodeFences(text);
	const objects: Array<{ value: Record<string, unknown>; repaired: boolean }> = [];
	let i = 0;
	while (i < source.length) {
		const start = source.indexOf("{", i);
		if (start === -1) break;
		const end = findObjectEnd(source, start);
		if (end !== -1) {
			const parsed = tryParseJson(source.slice(start, end + 1));
			if (parsed.ok && isPlainObject(parsed.value)) {
				objects.push({ value: parsed.value, repaired: parsed.repaired });
				i = end + 1; // skip nested objects of a parsed top-level object
				continue;
			}
		}
		i = start + 1;
	}
	return objects;
}

type DeterministicOutcome<T> =
	| { ok: true; value: T; repaired: boolean; candidates: number }
	| { ok: false; kind: "no-json" | "schema"; issues: string[] };

function formatIssues(issues: ValidationIssue[]): string[] {
	return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

/**
 * Deterministically extract and validate the result. The last JSON object
 * that satisfies the schema wins; if none does, the issues of the last parsed
 * object are reported.
 */
export function parseResultDeterministic<T>(schema: ResultSchema<T>, rawText: string): DeterministicOutcome<T> {
	const objects = extractJsonObjects(rawText);
	if (objects.length === 0) {
		return { ok: false, kind: "no-json", issues: ["no JSON object found in output"] };
	}
	let lastIssues: ValidationIssue[] = [];
	for (let i = objects.length - 1; i >= 0; i--) {
		const candidate = objects[i]!;
		const validation = validateResult(schema, candidate.value);
		if (validation.ok) {
			return { ok: true, value: validation.value, repaired: candidate.repaired || objects.length > 1, candidates: objects.length };
		}
		if (i === objects.length - 1) lastIssues = validation.issues;
	}
	return { ok: false, kind: "schema", issues: formatIssues(lastIssues) };
}

// --- LLM repair ---

/** Request passed to the injected LLM repair function. */
export interface RepairRequest {
	/** Agent name (schema name). */
	agent: string;
	systemPrompt: string;
	prompt: string;
}

/** Injected LLM repair: returns the model's raw answer text (should be JSON only). */
export type RepairFunction = (request: RepairRequest) => Promise<string>;

export const REPAIR_SYSTEM_PROMPT =
	"You repair malformed JSON output of an automated coding agent. " +
	"You never add information that is not present in the original output. " +
	"Respond with a single valid JSON object only — no prose, no markdown, no code fences.";

/** Maximum number of raw-output characters included in the repair prompt. */
export const REPAIR_MAX_RAW_CHARS = 20000;

/** Build the repair prompt: expected schema + problems + raw subagent text → JSON only. */
export function buildRepairPrompt(schema: ResultSchema<unknown>, rawText: string, issues: string[]): string {
	let raw = rawText;
	if (raw.length > REPAIR_MAX_RAW_CHARS) {
		// The result is expected at the end of the output, so keep the tail.
		raw = `…(truncated)…\n${raw.slice(raw.length - REPAIR_MAX_RAW_CHARS)}`;
	}
	return [
		`The final output of the "${schema.name}" agent should be a single JSON object matching this schema`,
		"(TypeScript-like notation, `?` marks optional properties):",
		"",
		describeSchema(schema),
		"",
		"Parsing the output failed:",
		...issues.map((issue) => `- ${issue}`),
		"",
		"Raw output of the agent (between the markers):",
		"<<<RAW_OUTPUT",
		raw,
		"RAW_OUTPUT>>>",
		"",
		"Return the agent's intended result as a single JSON object that matches the schema.",
		"Preserve the agent's meaning and wording; do not invent values. If a required value is",
		"genuinely missing, choose the most conservative value (e.g. `false` for success flags).",
		"Respond with JSON only.",
	].join("\n");
}

// --- Public parse API ---

export type ParseMethod = "direct" | "deterministic-repair" | "llm-repair";

export interface ParseSuccess<T> {
	ok: true;
	value: T;
	/** How the result was obtained. */
	method: ParseMethod;
}

export type ParseFailureKind = "empty" | "no-json" | "schema" | "repair-error";

export interface ParseFailure {
	ok: false;
	kind: ParseFailureKind;
	agent: string;
	/** Problems found by deterministic parsing (or in the repaired output). */
	issues: string[];
	/** Whether the LLM repair was attempted. */
	repairAttempted: boolean;
	/** Error thrown by the repair function (kind "repair-error"). */
	repairError?: string;
	/** Snippet of the raw output (tail, whitespace collapsed). */
	rawSnippet: string;
	/** Complete human-readable error message incl. raw snippet. */
	message: string;
}

export type ParseOutcome<T> = ParseSuccess<T> | ParseFailure;

export interface ParseOptions {
	/** Injected LLM repair, called at most once. Omit to disable LLM repair. */
	repair?: RepairFunction;
	/** Maximum snippet length in failure messages (default 300). */
	snippetLength?: number;
}

export const DEFAULT_SNIPPET_LENGTH = 300;

/** Tail snippet of the raw output with whitespace collapsed. */
export function rawSnippet(rawText: string, maxLength: number = DEFAULT_SNIPPET_LENGTH): string {
	const clean = rawText.replace(/\s+/g, " ").trim();
	if (!clean) return "(empty output)";
	if (clean.length <= maxLength) return clean;
	return `…${clean.slice(clean.length - maxLength + 1)}`;
}

function buildFailure(
	agent: string,
	kind: ParseFailureKind,
	issues: string[],
	rawText: string,
	repairAttempted: boolean,
	repairError: string | undefined,
	snippetLength: number,
): ParseFailure {
	const snippet = rawSnippet(rawText, snippetLength);
	let headline: string;
	switch (kind) {
		case "empty":
			headline = `${agent} returned no output`;
			break;
		case "no-json":
			headline = `${agent} did not return a JSON result`;
			break;
		case "schema":
			headline = `${agent} returned JSON that does not match the expected schema`;
			break;
		case "repair-error":
			headline = `${agent} returned invalid JSON and the LLM repair failed`;
			break;
	}
	const parts = [`Failed to parse result: ${headline}`];
	if (issues.length > 0) parts.push(`(${issues.join("; ")})`);
	if (repairError) parts.push(`— repair error: ${repairError}`);
	else if (repairAttempted) parts.push("— LLM repair did not produce a valid result");
	parts.push(`— raw output: "${snippet}"`);
	return {
		ok: false,
		kind,
		agent,
		issues,
		repairAttempted,
		repairError,
		rawSnippet: snippet,
		message: parts.join(" "),
	};
}

/**
 * Parse a subagent's raw final text into a schema-validated result.
 *
 * Deterministic extraction first; if that fails and a repair function is
 * given, it is called exactly once and its answer is parsed and validated
 * again. Never throws.
 */
export async function parseSubagentResult<T>(
	schema: ResultSchema<T>,
	rawText: string,
	options: ParseOptions = {},
): Promise<ParseOutcome<T>> {
	const snippetLength = options.snippetLength ?? DEFAULT_SNIPPET_LENGTH;

	if (!rawText.trim()) {
		return buildFailure(schema.name, "empty", [], rawText, false, undefined, snippetLength);
	}

	const deterministic = parseResultDeterministic(schema, rawText);
	if (deterministic.ok) {
		const direct = !deterministic.repaired && safeParseWhole(rawText);
		return { ok: true, value: deterministic.value, method: direct ? "direct" : "deterministic-repair" };
	}

	if (!options.repair) {
		return buildFailure(schema.name, deterministic.kind, deterministic.issues, rawText, false, undefined, snippetLength);
	}

	let repairedText: string;
	try {
		repairedText = await options.repair({
			agent: schema.name,
			systemPrompt: REPAIR_SYSTEM_PROMPT,
			prompt: buildRepairPrompt(schema, rawText, deterministic.issues),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildFailure(schema.name, "repair-error", deterministic.issues, rawText, true, message, snippetLength);
	}

	const repaired = parseResultDeterministic(schema, repairedText ?? "");
	if (repaired.ok) {
		return { ok: true, value: repaired.value, method: "llm-repair" };
	}

	const issues = [...deterministic.issues, ...repaired.issues.map((issue) => `after repair: ${issue}`)];
	return buildFailure(schema.name, deterministic.kind, issues, rawText, true, undefined, snippetLength);
}

/** True if the whole (trimmed) text is a single valid JSON value. */
function safeParseWhole(text: string): boolean {
	try {
		JSON.parse(text.trim());
		return true;
	} catch {
		return false;
	}
}
