/**
 * PRD Loop Pro — Autonomous Task Orchestrator with Subagents
 *
 * Commands:
 * - /prd-loop-pro [prd-N] — Execute all tasks of a PRD autonomously
 * - /ralph-pro [prd-N]    — Alias for /prd-loop-pro
 *
 * `prd-N` is the only argument. All other configuration lives in persisted
 * settings (see ./settings.ts and ./settings-ui.ts).
 *
 * Start sequence:
 * 1. Git status (uncommitted changes are only allowed while resolving a
 *    `needs-human` task, see ./task-index.ts `checkGitClean`)
 * 1b. Load the commit rules from the package's `/commit` prompt template
 *     (missing template = hard error)
 * 2. `needs-human` tasks first: "Commit changes (committer) & close",
 *    "Already committed – just close", "Review again", "Not now"
 * 2b. PRD selection (dialog, argument or the PRD of the resolved task)
 * 3. Load global settings (wizard on first start), merge per-field project
 *    overrides (`.pi/prd-loop-pro.json`) and validate
 * 4. Overview dialog: Confirm & start / Change (per-entry menu) / Cancel
 * 5. Orchestrator loop per task: Implement (prd-worker) → Review-fix cycle
 *    (./review-cycle.ts: fresh prd-reviewer per round, one fresh prd-fixer per
 *    finding at/above the fix threshold, sequentially P0 first; re-review only
 *    if something was fixed; rejected findings + reasons go into the next
 *    review prompt; round limit → pause menu) → Commit (prd-committer; failure
 *    or hook failure pauses the loop, hooks are never bypassed) → Report
 *    (`## Execution Report` in the task todo incl. rounds, fixed, rejected,
 *    deferred, unresolved findings and created commits, close todo, update
 *    PRD Task Index)
 *
 * "Release (fix manually)" (round limit, commit failure, manual pause) sets the
 * task todo to `needs-human`, appends the open findings and stops the loop.
 * `needs-human` is not closed: dependent tasks stay blocked until the task is
 * resolved at the next start.
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import type { PrdLoopProSettings, StepSetting } from "./settings.ts";
import { findModel } from "./settings.ts";
import { resolveStartSettings } from "./settings-ui.ts";
import {
	COMMITTER_RESULT_SCHEMA,
	FIXER_RESULT_SCHEMA,
	parseSubagentResult,
	rawSnippet,
	REVIEWER_RESULT_SCHEMA,
	WORKER_RESULT_SCHEMA,
} from "./subagent-result.ts";
import type {
	FindingPriority,
	RepairFunction,
	ResultSchema,
	ReviewerResult,
	ReviewFinding,
	WorkerResult,
} from "./subagent-result.ts";
import { appendSection, buildExecutionReport, buildOpenFindingsSection, formatLocation } from "./execution-report.ts";
import type { CommitRef, CostPhase, ExecutionRecord, RejectedFinding, UnresolvedFinding } from "./execution-report.ts";
import {
	checkGitClean,
	isNeedsHuman,
	isTaskClosed,
	NEEDS_HUMAN_STATUS,
	parseBlockedBy,
	resolveTaskOrder,
	syncPrdTaskIndex,
} from "./task-index.ts";
import type { TaskInfo } from "./task-index.ts";
import {
	applyFixOutcome,
	applyReview,
	commitAsIs,
	createReviewCycle,
	cycleCounts,
	extendRoundLimit,
	nextStep,
	openFindings,
	rejectedForNextReview,
	reportFields,
	unresolvedFindings,
} from "./review-cycle.ts";
import type { CycleStep, FixOutcome, ReviewCycleState } from "./review-cycle.ts";
import { buildFixerPrompt } from "./fixer-prompt.ts";
import { buildReviewerPrompt, filterReviewableStatus, REVIEW_EXCLUDED_DIR, REVIEW_PATHSPEC } from "./reviewer-prompt.ts";
import { buildCommitterPrompt, loadCommitRules } from "./committer-prompt.ts";
import { loadProjectReviewGuidelines } from "../review/review-prompts.ts";

/** Extension directory for locating agent definition files. */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

// --- Todo types and helpers ---

interface TodoItem {
	id: string;
	title: string;
	tags: string[];
	status: string;
	body: string;
}

/**
 * Parse a todo .md file: JSON frontmatter followed by markdown body.
 */
function parseTodoFile(content: string): TodoItem | null {
	// The file starts with JSON (until closing `}`), then the body follows
	const lines = content.split("\n");
	let braceDepth = 0;
	let jsonEndLine = -1;

	for (let i = 0; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === "{") braceDepth++;
			else if (ch === "}") braceDepth--;
		}
		if (braceDepth === 0 && i > 0) {
			jsonEndLine = i;
			break;
		}
		// Handle single-line JSON edge case
		if (braceDepth === 0 && i === 0 && lines[i].includes("{")) {
			jsonEndLine = 0;
			break;
		}
	}

	if (jsonEndLine === -1) return null;

	const jsonStr = lines.slice(0, jsonEndLine + 1).join("\n");
	const body = lines.slice(jsonEndLine + 1).join("\n").trim();

	try {
		const meta = JSON.parse(jsonStr);
		return {
			id: meta.id,
			title: meta.title,
			tags: meta.tags || [],
			status: meta.status || "open",
			body,
		};
	} catch {
		return null;
	}
}

/**
 * Read all todo files from .pi/todos/
 */
async function readAllTodos(cwd: string): Promise<TodoItem[]> {
	const todosDir = join(cwd, ".pi", "todos");
	let files: string[];
	try {
		files = await readdir(todosDir);
	} catch {
		return [];
	}

	const todos: TodoItem[] = [];
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		try {
			const content = await readFile(join(todosDir, file), "utf-8");
			const todo = parseTodoFile(content);
			if (todo) todos.push(todo);
		} catch {
			// Skip unreadable files
		}
	}
	return todos;
}

/**
 * Get all PRD todos (tagged with "prd") that have at least one open task.
 */
async function getActivePrds(cwd: string): Promise<{ prd: TodoItem; openTaskCount: number; totalTaskCount: number }[]> {
	const todos = await readAllTodos(cwd);

	// Find PRDs
	const prds = todos.filter((t) => t.tags.includes("prd"));

	const result: { prd: TodoItem; openTaskCount: number; totalTaskCount: number }[] = [];

	for (const prd of prds) {
		// Find the prd-N tag to identify associated tasks
		const prdTag = prd.tags.find((tag) => /^prd-\d+$/.test(tag));
		if (!prdTag) continue;

		// Find all tasks for this PRD
		const tasks = todos.filter((t) => t.tags.includes("task") && t.tags.includes(prdTag));
		const openTasks = tasks.filter((t) => !isTaskClosed(t.status));

		if (openTasks.length > 0) {
			result.push({ prd, openTaskCount: openTasks.length, totalTaskCount: tasks.length });
		}
	}

	return result;
}

// --- Command argument parsing ---

/** Parsed command arguments: `prd-N` is the only supported argument. */
interface ParsedArgs {
	prdTag: string | null;
	error: string | null;
}

const USAGE = "Usage: /prd-loop-pro [prd-N]";

/**
 * Parse the command args string. Accepts an optional `prd-N` argument and
 * nothing else; all other configuration lives in the persisted settings.
 */
export function parseCommandArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let prdTag: string | null = null;

	for (const token of tokens) {
		if (/^prd-\d+$/i.test(token) && prdTag === null) {
			prdTag = token.toLowerCase();
		} else {
			return { prdTag: null, error: `Unexpected argument: "${token}". ${USAGE}` };
		}
	}

	return { prdTag, error: null };
}

// --- Subagent types and spawning ---

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Worker-level result of one implementation attempt (after parsing). */
export interface SubagentResult {
	success: boolean;
	errors: string[];
	summary: string;
	usage: SubagentUsage;
}

/**
 * Raw result of a subagent run. Parsing of the final text into a typed agent
 * result happens in ./subagent-result.ts.
 */
export interface SubagentRunResult {
	/** completed = the agent finished (final text available); aborted = cancelled; failed = process error. */
	status: "completed" | "aborted" | "failed";
	/** Final assistant text (raw, unparsed). */
	finalText: string;
	usage: SubagentUsage;
	/** Activity events collected during the run (same format as the output viewer). */
	events: OutputEvent[];
	/** Error description for aborted/failed runs. */
	error?: string;
}

/** Activity update from a running subagent. */
export interface SubagentActivity {
	/** Type of activity */
	type: "tool_start" | "tool_end" | "text_delta" | "thinking";
	/** Tool name (for tool_start/tool_end) */
	toolName?: string;
	/** Tool arguments summary (for tool_start) */
	argsSummary?: string;
	/** Whether tool succeeded (for tool_end) */
	toolSuccess?: boolean;
	/** Text snippet (for text_delta) */
	text?: string;
	/** Current turn number */
	turn: number;
	/** Preview of tool result (for tool_end) */
	resultPreview?: string;
}

/** Structured event from a running subagent, stored for the output viewer. */
export interface OutputEvent {
	time: number;
	kind: "tool_start" | "tool_end" | "text" | "thinking";
	tool?: string;
	args?: string;
	result?: string;
	error?: boolean;
	text?: string;
	turn: number;
}

/**
 * Append a subagent activity to an output event list. Consecutive text/thinking
 * deltas are collapsed into a single event.
 */
export function appendOutputEvent(events: OutputEvent[], activity: SubagentActivity, now: number = Date.now()): void {
	switch (activity.type) {
		case "tool_start":
			events.push({ time: now, kind: "tool_start", tool: activity.toolName, args: activity.argsSummary, turn: activity.turn });
			break;
		case "tool_end":
			events.push({
				time: now,
				kind: "tool_end",
				tool: activity.toolName,
				error: !activity.toolSuccess,
				result: activity.resultPreview,
				turn: activity.turn,
			});
			break;
		case "text_delta":
			if (events.at(-1)?.kind !== "text") events.push({ time: now, kind: "text", turn: activity.turn });
			break;
		case "thinking":
			if (events.at(-1)?.kind !== "thinking") events.push({ time: now, kind: "thinking", turn: activity.turn });
			break;
	}
}

/**
 * Summarize tool arguments into a compact one-line string for display.
 */
function summarizeToolArgs(toolName: string, args: any): string {
	if (!args) return "";
	switch (toolName) {
		case "bash":
			return args.command ? truncateStr(args.command, 60) : "";
		case "read":
			return args.path ?? "";
		case "write":
			return args.path ?? "";
		case "edit":
			return args.path ?? "";
		case "grep":
		case "find":
		case "ls":
			return args.path ?? args.pattern ?? "";
		default:
			// For custom tools, show first string arg
			for (const v of Object.values(args)) {
				if (typeof v === "string") return truncateStr(v, 60);
			}
			return "";
	}
}

/**
 * Truncate a string to maxLen, appending "…" if truncated.
 */
function truncateStr(s: string, maxLen: number): string {
	// Replace newlines and tabs with spaces for display
	const clean = s.replace(/[\n\t\r]/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	return clean.slice(0, maxLen - 1) + "…";
}

interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

/**
 * Load an agent definition from a .md file with YAML frontmatter.
 */
function loadAgentDefinition(filePath: string, content: string): AgentDefinition | null {
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

	if (!frontmatter.name || !frontmatter.description) return null;

	const tools = frontmatter.tools
		?.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model,
		systemPrompt: body,
		filePath,
	};
}

/**
 * Load an agent definition (e.g. "prd-worker", "prd-reviewer") from the
 * extension's agents/ directory.
 */
async function loadAgent(extensionDir: string, name: string): Promise<AgentDefinition> {
	const agentPath = join(extensionDir, "agents", `${name}.md`);
	const content = await readFile(agentPath, "utf-8");
	const agent = loadAgentDefinition(agentPath, content);
	if (!agent) {
		throw new Error(`Failed to parse ${name} agent at ${agentPath}`);
	}
	return agent;
}

/**
 * Load the prd-worker agent definition from the extension's agents/ directory.
 */
async function loadPrdWorkerAgent(extensionDir: string): Promise<AgentDefinition> {
	return loadAgent(extensionDir, "prd-worker");
}

/**
 * Get the final assistant text output from the message stream.
 */
function getFinalAssistantText(messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const text = msg.content
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text!)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}

const SIGKILL_TIMEOUT_MS = 5000;

/** Timeout (ms) to wait for process exit after receiving the agent_settled event. */
const AGENT_END_EXIT_TIMEOUT_MS = 10000;

/**
 * Spawn a pi subagent process to execute a task.
 *
 * The subagent runs in an isolated context window with the given agent definition
 * as its system prompt. The runner does not interpret the agent's answer: it
 * returns the raw final text, usage and collected activity events. Parsing into
 * a typed result happens in ./subagent-result.ts (see `parseRunResult`).
 *
 * @param options.taskPrompt - The full prompt to send to the subagent (task body + context)
 * @param options.model - Model to use (overrides agent default)
 * @param options.cwd - Working directory for the subagent process
 * @param options.agent - The agent definition (e.g. loaded from prd-worker.md)
 * @param options.signal - AbortSignal for cancellation
 * @returns SubagentRunResult with status, raw final text, usage stats and events
 */
export async function spawnSubagent(options: {
	taskPrompt: string;
	model?: string;
	thinkingLevel?: string;
	cwd: string;
	agent: AgentDefinition;
	signal?: AbortSignal;
	onActivity?: (activity: SubagentActivity) => void;
}): Promise<SubagentRunResult> {
	const { taskPrompt, model, thinkingLevel, cwd, agent, signal, onActivity } = options;

	const events: OutputEvent[] = [];
	const emitActivity = (activity: SubagentActivity) => {
		appendOutputEvent(events, activity);
		onActivity?.(activity);
	};

	// Write agent system prompt to temp file
	const tmpDir = mkdtempSync(join(tmpdir(), "prd-loop-pro-"));
	const promptPath = join(tmpDir, `${agent.name}-prompt.md`);
	writeFileSync(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });

	// Build pi arguments — disable extension/theme discovery to keep the subagent
	// isolated and avoid unrelated hooks interfering with clean shutdown. We still
	// explicitly load cc-support so Anthropic subagents get the same Claude Code
	// user-agent + system-prompt rewrite as the parent agent.
	const args: string[] = [
		"--mode", "json", "-p", "--no-session",
		"--no-extensions", "--no-themes",
	];

	const ccSupportExtensionPath = join(EXTENSION_DIR, "..", "cc-support", "index.ts");
	if (existsSync(ccSupportExtensionPath)) {
		args.push("--extension", ccSupportExtensionPath);
	}

	// Model: prefer explicit option, fall back to agent definition
	const effectiveModel = model ?? agent.model;
	if (effectiveModel) args.push("--model", effectiveModel);

	// Thinking level
	if (thinkingLevel) args.push("--thinking", thinkingLevel);

	// Tools from agent definition
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	// System prompt
	args.push("--append-system-prompt", promptPath);

	// Task prompt as the user message
	args.push(taskPrompt);

	const usage: SubagentUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};

	const messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> = [];
	/** Messages from the most recent agent_end event (one low-level run; retries/recovery can emit several). */
	let agentEndMessages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> | null = null;
	/** True once agent_settled was received: pi has no remaining automatic work. */
	let settled = false;
	let stderr = "";
	let wasAborted = false;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			let resolved = false;
			const safeResolve = (code: number) => {
				if (resolved) return;
				resolved = true;
				resolve(code);
			};

			const proc = spawn("pi", args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let agentEndExitTimer: ReturnType<typeof setTimeout> | null = null;

			const processLine = (line: string) => {
				if (!line.trim()) return;

				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// agent_end closes one low-level run. Automatic retries, overflow
				// recovery or compaction can still continue afterwards, so keep only
				// the latest run's messages (they contain the final assistant answer).
				// Usage is accumulated from message_end events across all runs.
				if (event.type === "agent_end" && Array.isArray(event.messages)) {
					agentEndMessages = event.messages;
				}

				// agent_settled is the authoritative completion signal: pi will not
				// continue automatically anymore.
				if (event.type === "agent_settled" && !settled) {
					settled = true;

					// Safety: if the process doesn't exit within timeout after
					// agent_settled, force-kill it and resolve (prevents hanging).
					agentEndExitTimer = setTimeout(() => {
						if (!resolved) {
							proc.kill("SIGTERM");
							setTimeout(() => {
								if (!proc.killed) proc.kill("SIGKILL");
							}, SIGKILL_TIMEOUT_MS);
							safeResolve(0); // Treat as success — agent completed
						}
					}, AGENT_END_EXIT_TIMEOUT_MS);
				}

				// Track message_end events for usage stats and live activity updates.
				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					messages.push(msg);

					if (msg.role === "assistant") {
						usage.turns++;
						const msgUsage = msg.usage;
						if (msgUsage) {
							usage.input += msgUsage.input || 0;
							usage.output += msgUsage.output || 0;
							usage.cacheRead += msgUsage.cacheRead || 0;
							usage.cacheWrite += msgUsage.cacheWrite || 0;
							usage.cost += msgUsage.cost?.total || 0;
							usage.contextTokens = msgUsage.totalTokens || 0;
						}
					}
				}

				// Stream activity events to the caller
				{
					if (event.type === "tool_execution_start") {
						emitActivity({
							type: "tool_start",
							toolName: event.toolName,
							argsSummary: summarizeToolArgs(event.toolName, event.args),
							turn: usage.turns + 1,
						});
					} else if (event.type === "tool_execution_end") {
						let resultPreview = "";
						try {
							const content = event.result?.content;
							if (Array.isArray(content)) {
								for (const item of content) {
									if (item.type === "text" && item.text) {
										resultPreview = truncateStr(item.text, 200);
										break;
									}
								}
							} else if (typeof event.result === "string") {
								resultPreview = truncateStr(event.result, 200);
							}
						} catch { /* ignore parse errors */ }
						emitActivity({
							type: "tool_end",
							toolName: event.toolName,
							toolSuccess: !event.isError,
							resultPreview,
							turn: usage.turns + 1,
						});
					} else if (event.type === "message_update" && event.assistantMessageEvent) {
						const ame = event.assistantMessageEvent;
						if (ame.type === "text_delta" && ame.delta) {
							emitActivity({
								type: "text_delta",
								text: ame.delta,
								turn: usage.turns + 1,
							});
						} else if (ame.type === "thinking_delta" || ame.type === "thinking") {
							emitActivity({
								type: "thinking",
								turn: usage.turns + 1,
							});
						}
					}
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on("close", (code: number | null) => {
				// Process remaining buffer
				if (buffer.trim()) processLine(buffer);
				if (agentEndExitTimer) clearTimeout(agentEndExitTimer);
				safeResolve(code ?? 0);
			});

			proc.on("error", () => {
				if (agentEndExitTimer) clearTimeout(agentEndExitTimer);
				safeResolve(1);
			});

			// Abort handling
			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, SIGKILL_TIMEOUT_MS);
				};

				if (signal.aborted) {
					killProc();
				} else {
					const abortHandler = () => killProc();
					signal.addEventListener("abort", abortHandler, { once: true });
					// Clean up the listener when the process exits to avoid leaks
					proc.on("close", () => {
						signal.removeEventListener("abort", abortHandler);
					});
				}
			}
		});

		// Prefer the last run's agent_end messages, fall back to incrementally
		// collected message_end messages.
		const finalText = getFinalAssistantText(agentEndMessages ?? messages);

		// Handle abort
		if (wasAborted) {
			return { status: "aborted", finalText, usage, events, error: "Subagent was aborted" };
		}

		// Handle non-zero exit code — but if we received agent_settled, the agent
		// DID complete; the non-zero code is likely from post-agent cleanup.
		if (exitCode !== 0 && !settled) {
			return {
				status: "failed",
				finalText,
				usage,
				events,
				error: `Subagent exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
			};
		}

		return { status: "completed", finalText, usage, events };
	} finally {
		// Clean up temp files
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

// --- Subagent result parsing & JSON repair ---

/**
 * Create the LLM repair function for invalid subagent JSON. Uses the
 * orchestrator model + thinking level from the settings, without tools.
 */
export function createOrchestratorRepair(
	modelRegistry: ExtensionCommandContext["modelRegistry"],
	step: StepSetting,
	options: { signal?: AbortSignal; onCost?: (cost: number) => void } = {},
): RepairFunction {
	return async (request) => {
		const model = findModel(modelRegistry.getAll(), step.model);
		if (!model) throw new Error(`orchestrator model "${step.model}" not found`);

		const reasoning = step.thinking && step.thinking !== "off" ? (step.thinking as AiThinkingLevel) : undefined;
		const stream = modelRegistry.streamSimple(
			model,
			{
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
			},
			{ reasoning, signal: options.signal },
		);
		const response = await stream.result();
		options.onCost?.(response.usage?.cost?.total ?? 0);

		if (response.stopReason === "aborted") throw new Error("JSON repair was aborted");
		if (response.stopReason === "error") {
			throw new Error(`${step.model}: ${response.errorMessage ?? "unknown error"}`);
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		if (!text.trim()) throw new Error(`${step.model} returned no text`);
		return text;
	};
}

/** Typed outcome of a subagent run after parsing its final text. */
export type ParsedRunResult<T> =
	| { ok: true; value: T; usage: SubagentUsage; events: OutputEvent[]; repaired: boolean }
	| { ok: false; status: SubagentRunResult["status"] | "invalid-result"; error: string; rawSnippet: string; usage: SubagentUsage; events: OutputEvent[] };

/**
 * Parse a raw subagent run into a typed result using the agent's schema.
 * Deterministic repair first, then (if given) one LLM repair attempt.
 * Cost of the repair call is added to the returned usage.
 */
export async function parseRunResult<T>(
	run: SubagentRunResult,
	schema: ResultSchema<T>,
	repair?: (onCost: (cost: number) => void) => RepairFunction,
): Promise<ParsedRunResult<T>> {
	if (run.status !== "completed") {
		return {
			ok: false,
			status: run.status,
			error: run.error ?? `Subagent ${run.status}`,
			rawSnippet: rawSnippet(run.finalText),
			usage: run.usage,
			events: run.events,
		};
	}

	let repairCost = 0;
	const outcome = await parseSubagentResult(schema, run.finalText, {
		repair: repair?.((cost) => {
			repairCost += cost;
		}),
	});
	const usage: SubagentUsage = { ...run.usage, cost: run.usage.cost + repairCost };

	if (!outcome.ok) {
		return { ok: false, status: "invalid-result", error: outcome.message, rawSnippet: outcome.rawSnippet, usage, events: run.events };
	}
	return { ok: true, value: outcome.value, usage, events: run.events, repaired: outcome.method === "llm-repair" };
}

/** Map a parsed prd-worker run to the worker-level result used by the orchestrator. */
function toWorkerResult(parsed: ParsedRunResult<WorkerResult>): SubagentResult {
	if (parsed.ok) {
		return { success: parsed.value.success, errors: parsed.value.errors, summary: parsed.value.summary, usage: parsed.usage };
	}
	const summary =
		parsed.status === "aborted"
			? "Task execution was cancelled"
			: parsed.status === "failed"
				? "Subagent process failed"
				: `Invalid result: ${parsed.rawSnippet}`;
	return { success: false, errors: [parsed.error], summary, usage: parsed.usage };
}

// --- Task resolution and dependency graph ---

/**
 * Extract the sequence label (e.g. "2/8") from a task title.
 */
function parseSequenceLabel(title: string): string {
	const match = title.match(/Task\s+(\d+\/\d+)/i);
	return match ? match[1] : "?/?";
}

/**
 * Fetch all tasks for a given PRD tag and parse their dependencies.
 */
export async function fetchPrdTasks(cwd: string, prdTag: string): Promise<TaskInfo[]> {
	const todos = await readAllTodos(cwd);

	return todos
		.filter((t) => t.tags.includes("task") && t.tags.includes(prdTag))
		.map((t) => ({
			id: t.id.startsWith("TODO-") ? t.id : `TODO-${t.id}`,
			title: t.title,
			status: t.status,
			body: t.body,
			blockedBy: parseBlockedBy(t.body),
			sequenceLabel: parseSequenceLabel(t.title),
		}));
}

// --- Todo file manipulation ---

/**
 * Convert a TODO-xxx id to the raw hex string used for filenames.
 */
function todoIdToHex(id: string): string {
	return id.replace(/^TODO-/, "");
}

/**
 * Split a todo file into its JSON frontmatter string and body.
 */
function splitTodoFile(content: string): { jsonStr: string; jsonEndLine: number; body: string } | null {
	const lines = content.split("\n");
	let braceDepth = 0;
	let jsonEndLine = -1;

	for (let i = 0; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === "{") braceDepth++;
			else if (ch === "}") braceDepth--;
		}
		if (braceDepth === 0 && i > 0) {
			jsonEndLine = i;
			break;
		}
		if (braceDepth === 0 && i === 0 && lines[i].includes("{")) {
			jsonEndLine = 0;
			break;
		}
	}

	if (jsonEndLine === -1) return null;

	return {
		jsonStr: lines.slice(0, jsonEndLine + 1).join("\n"),
		jsonEndLine,
		body: lines.slice(jsonEndLine + 1).join("\n"),
	};
}

/**
 * Update a todo file's status in its JSON frontmatter.
 */
async function updateTodoFileStatus(cwd: string, todoId: string, newStatus: string): Promise<void> {
	const hex = todoIdToHex(todoId);
	const filePath = join(cwd, ".pi", "todos", `${hex}.md`);
	const content = await readFile(filePath, "utf-8");

	const split = splitTodoFile(content);
	if (!split) throw new Error(`Invalid todo file format: ${filePath}`);

	const meta = JSON.parse(split.jsonStr);
	meta.status = newStatus;

	writeFileSync(filePath, JSON.stringify(meta, null, 2) + split.body, "utf-8");
}

/**
 * Read a todo file's body content.
 */
async function readTodoBody(cwd: string, todoId: string): Promise<string> {
	const hex = todoIdToHex(todoId);
	const filePath = join(cwd, ".pi", "todos", `${hex}.md`);
	const content = await readFile(filePath, "utf-8");

	const split = splitTodoFile(content);
	if (!split) throw new Error(`Invalid todo file format: ${filePath}`);

	return split.body.trim();
}

/**
 * Update a todo file's body content (preserves JSON frontmatter).
 */
async function updateTodoFileBody(cwd: string, todoId: string, newBody: string): Promise<void> {
	const hex = todoIdToHex(todoId);
	const filePath = join(cwd, ".pi", "todos", `${hex}.md`);
	const content = await readFile(filePath, "utf-8");

	const split = splitTodoFile(content);
	if (!split) throw new Error(`Invalid todo file format: ${filePath}`);

	writeFileSync(filePath, split.jsonStr + "\n\n" + newBody + "\n", "utf-8");
}

// --- PRD Task Index ---

/** Re-sync the PRD Task Index (status column + "Next up" pointer) with the given task statuses. */
async function syncPrdTaskIndexFile(cwd: string, prdId: string, tasks: TaskInfo[]): Promise<void> {
	const currentPrdBody = await readTodoBody(cwd, prdId);
	const syncedBody = syncPrdTaskIndex(currentPrdBody, tasks);
	if (syncedBody !== currentPrdBody) {
		await updateTodoFileBody(cwd, prdId, syncedBody);
	}
}

/** One-line description of held tasks (`needs-human` + their dependents). */
function formatHeldTasks(held: TaskInfo[]): string {
	const needsHuman = held.filter((t) => isNeedsHuman(t.status));
	const blocked = held.length - needsHuman.length;
	const names = needsHuman.map((t) => `${t.id} (Task ${t.sequenceLabel})`).join(", ");
	return (
		`${needsHuman.length} task${needsHuman.length === 1 ? " needs" : "s need"} a human: ${names}` +
		(blocked > 0 ? `; ${blocked} dependent task${blocked === 1 ? " is" : "s are"} blocked` : "") +
		". Re-run /prd-loop-pro to resolve."
	);
}

// --- Needs-human resolution ---

/** How a `needs-human` task is resolved at start. */
type NeedsHumanAction = "commit" | "close" | "review" | "not-now";

/** A `needs-human` task to resolve inside the orchestrator loop (runs first). */
interface NeedsHumanResume {
	taskId: string;
	/** "commit" = commit phase only; "review" = review-fix cycle, then commit. */
	mode: "commit" | "review";
}

interface NeedsHumanTask {
	task: TodoItem;
	/** TODO-xxx id */
	taskId: string;
	prdTag: string;
	/** PRD todo (if found) */
	prd?: TodoItem;
}

/** All `needs-human` task todos (optionally restricted to one PRD), with their PRD. */
async function getNeedsHumanTasks(cwd: string, prdTag: string | null): Promise<NeedsHumanTask[]> {
	const todos = await readAllTodos(cwd);
	const result: NeedsHumanTask[] = [];
	for (const todo of todos) {
		if (!todo.tags.includes("task") || !isNeedsHuman(todo.status)) continue;
		const tag = todo.tags.find((t) => /^prd-\d+$/.test(t));
		if (!tag || (prdTag && tag !== prdTag)) continue;
		result.push({
			task: todo,
			taskId: todo.id.startsWith("TODO-") ? todo.id : `TODO-${todo.id}`,
			prdTag: tag,
			prd: todos.find((t) => t.tags.includes("prd") && t.tags.includes(tag)),
		});
	}
	return result.sort((a, b) => a.prdTag.localeCompare(b.prdTag) || a.task.title.localeCompare(b.task.title));
}

/**
 * Ask how to resolve a `needs-human` task. Cancelling the dialog = "Not now".
 */
async function showNeedsHumanMenu(
	ctx: ExtensionCommandContext,
	entry: NeedsHumanTask,
	dirty: boolean,
): Promise<NeedsHumanAction> {
	const titleLines = [
		`🔧 Task needs a human — ${entry.task.title}`,
		entry.prd ? `PRD: ${entry.prd.title}` : `PRD: ${entry.prdTag}`,
		"",
		dirty
			? "The working tree has uncommitted changes (assumed to be your work on this task)."
			: "The working tree is clean.",
	];
	const actions: NeedsHumanAction[] = ["commit", "close", "review", "not-now"];
	const labels: Record<NeedsHumanAction, string> = {
		commit: "📝 Commit changes (committer) & close — then continue with the next task",
		close: "✅ Already committed – just close — then continue with the next task",
		review: "🔍 Review again — run the review-fix cycle on the current changes, then commit & close",
		"not-now": "⏭️  Not now — leave the task as needs-human",
	};
	const menu = actions.map((action) => labels[action]);
	const choice = await ctx.ui.select(titleLines.join("\n"), menu);
	const index = choice === undefined ? -1 : menu.indexOf(choice);
	return index === -1 ? "not-now" : actions[index]!;
}

/**
 * "Already committed – just close": append the execution report, close the
 * todo and update the PRD Task Index (closes the PRD if all tasks are closed).
 */
async function closeNeedsHumanTask(cwd: string, entry: NeedsHumanTask): Promise<void> {
	const record: ExecutionRecord = {
		implementerSummary: "Resolved manually after the task was released to a human (needs-human).",
		reviewRounds: 0,
		reviewNote: "Closed as already committed — no automated review or commit after the manual resolution.",
		fixed: [],
		rejected: [],
		deferred: [],
		unresolved: [],
		callouts: [],
		commits: [],
		cost: {},
	};
	const body = await readTodoBody(cwd, entry.taskId);
	await updateTodoFileBody(cwd, entry.taskId, appendSection(body, buildExecutionReport(record)));
	await updateTodoFileStatus(cwd, entry.taskId, "closed");

	if (!entry.prd) return;
	const prdId = entry.prd.id.startsWith("TODO-") ? entry.prd.id : `TODO-${entry.prd.id}`;
	const tasks = await fetchPrdTasks(cwd, entry.prdTag);
	await syncPrdTaskIndexFile(cwd, prdId, tasks);
	if (tasks.every((t) => isTaskClosed(t.status)) && !isTaskClosed(entry.prd.status)) {
		await updateTodoFileStatus(cwd, prdId, "closed");
	}
}

/** Outcome of offering the `needs-human` tasks at start. */
interface NeedsHumanStartResult {
	/** Task to resolve inside the loop ("Commit changes" / "Review again"). */
	resume?: { entry: NeedsHumanTask; mode: NeedsHumanResume["mode"] };
	/** PRD tag of the last task closed via "Already committed – just close". */
	closedPrdTag?: string;
}

/**
 * Offer `needs-human` tasks first (before PRD selection). With several
 * tasks, the user picks one (or continues without resolving); every task gets
 * the four options. "Just close" is handled here and the remaining tasks are
 * offered again; "Commit" / "Review again" end the dialog and are resolved
 * inside the orchestrator loop.
 */
async function offerNeedsHumanTasks(
	ctx: ExtensionCommandContext,
	candidates: NeedsHumanTask[],
	dirty: boolean,
): Promise<NeedsHumanStartResult> {
	const result: NeedsHumanStartResult = {};
	const remaining = [...candidates];

	while (remaining.length > 0) {
		let entry: NeedsHumanTask;
		if (remaining.length === 1) {
			entry = remaining[0]!;
		} else {
			const skipAll = "⏭️  Not now — continue without resolving";
			const options = remaining.map((e) => `🔧 ${e.task.title}`);
			const choice = await ctx.ui.select(
				`🔧 ${remaining.length} tasks need a human — pick one to resolve:`,
				[...options, skipAll],
			);
			const index = choice === undefined ? -1 : options.indexOf(choice);
			if (index === -1) break;
			entry = remaining[index]!;
		}

		const action = await showNeedsHumanMenu(ctx, entry, dirty);
		remaining.splice(remaining.indexOf(entry), 1);

		switch (action) {
			case "not-now":
				continue;
			case "close":
				await closeNeedsHumanTask(ctx.cwd, entry);
				result.closedPrdTag = entry.prdTag;
				ctx.ui.notify(`✅ Closed ${entry.taskId} (${extractShortTitle(entry.task.title)}).`, "info");
				continue;
			case "commit":
			case "review":
				result.resume = { entry, mode: action };
				return result;
		}
	}

	return result;
}

// --- Prompt builders ---

/**
 * Build the subagent prompt for a task.
 */
function buildTaskPrompt(task: TaskInfo, prdId: string): string {
	return [
		`# Task: ${task.title}`,
		``,
		task.body,
		``,
		`---`,
		``,
		`If you need more context about the overall project, read the PRD todo: ${prdId}`,
	].join("\n");
}

/**
 * Build an augmented prompt for a retry attempt.
 *
 * Includes the original task body plus a section describing the errors from
 * the previous attempt. Instructs the subagent to fix existing code on disk
 * rather than starting from scratch.
 */
export function buildRetryPrompt(task: TaskInfo, prdId: string, errors: string[]): string {
	const basePrompt = buildTaskPrompt(task, prdId);

	const numberedErrors = errors
		.map((err, i) => `${i + 1}. ${err}`)
		.join("\n");

	return [
		basePrompt,
		``,
		`---`,
		``,
		`## ⚠️ Previous Attempt Failed`,
		``,
		`The previous attempt to complete this task failed with the following errors:`,
		``,
		numberedErrors,
		``,
		`The code from the previous attempt is still on disk (uncommitted). Fix the issues rather than starting from scratch.`,
		`Run \`git diff\` to see what was changed by the previous attempt.`,
	].join("\n");
}

/**
 * Build a continuation prompt after the user paused and resumed.
 *
 * The previous subagent was interrupted but its partial changes are still on disk.
 * Instructs the new subagent to continue from where it left off.
 */
export function buildContinuePrompt(task: TaskInfo, prdId: string): string {
	const basePrompt = buildTaskPrompt(task, prdId);

	return [
		basePrompt,
		``,
		`---`,
		``,
		`## ℹ️ Continuation`,
		``,
		`A previous attempt was interrupted. The partial changes are still on disk (uncommitted).`,
		`Run \`git diff\` to see what was already done, then continue from where it left off.`,
		`Do not redo work that is already complete.`,
	].join("\n");
}

/**
 * Extract the short title from a task title (removes "PRD #N - Task M/T: " prefix).
 */
function extractShortTitle(title: string): string {
	const match = title.match(/Task\s+\d+\/\d+:\s*(.*)/i);
	return match ? match[1].trim() : title;
}

// --- Loop state and UI ---

/** `needs-human` = released to a human (todo status `needs-human`), resolved at the next start. */
type TaskStatus = "pending" | "running" | "completed" | "failed" | "retrying" | "aborted" | "needs-human";

/** Pipeline phase of a task (shown in the overlay while the task is active). */
type TaskPhase = "Implement" | "Review" | "Fix" | "Commit";

interface LoopTaskState {
	id: string;
	title: string;
	sequenceLabel: string;
	status: TaskStatus;
	/** Current pipeline phase (while running/retrying). */
	phase?: TaskPhase;
	/** Display label of the current phase incl. round progress (e.g. "Review 2/3", "Fix 2/4 [P1] Title"). */
	phaseLabel?: string;
	/** One-line review outcome (verdict + counts), once the review ran. */
	reviewInfo?: string;
	startTime?: number;
	endTime?: number;
	cost: number;
	retries: number;
	errors: string[];
	summary?: string;
	/** Current subagent activity (while running) */
	currentActivity?: string;
	/** Current turn of the subagent */
	currentTurn: number;
	/** Collected output events for the viewer overlay */
	outputEvents: OutputEvent[];
}

interface LoopState {
	startTime: number;
	tasks: LoopTaskState[];
	totalCost: number;
	totalCommits: number;
	currentTaskIndex: number;
	currentRetry: number;
	maxRetries: number;
}

/**
 * Format elapsed milliseconds as "M:SS".
 */
function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Get the status icon for a task state.
 */
function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "pending": return "⏳";
		case "running": return "🔄";
		case "completed": return "✅";
		case "failed": return "❌";
		case "retrying": return "🔁";
		case "aborted": return "⚠️";
		case "needs-human": return "🔧";
	}
}

function taskStatusColor(status: TaskStatus): "accent" | "dim" | "error" | "success" | "warning" {
	switch (status) {
		case "pending": return "dim";
		case "running": return "accent";
		case "completed": return "success";
		case "failed": return "error";
		case "retrying": return "warning";
		case "aborted": return "warning";
		case "needs-human": return "warning";
	}
}

/** True while a task is being worked on (phase is meaningful). */
function isTaskActive(task: LoopTaskState): boolean {
	return task.status === "running" || task.status === "retrying";
}

/** Phase label of an active task (incl. round progress), or undefined. */
function activePhaseLabel(task: LoopTaskState): string | undefined {
	if (!isTaskActive(task)) return undefined;
	return task.phaseLabel ?? task.phase;
}

function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function frameOverlayLines(lines: string[], innerWidth: number, theme: Theme): string[] {
	const border = (text: string) => theme.fg("borderAccent", text);
	const top = border(`╭${"─".repeat(innerWidth)}╮`);
	const bottom = border(`╰${"─".repeat(innerWidth)}╯`);
	const framed = lines.map((line) => {
		const truncated = truncateToWidth(line, innerWidth);
		return border("│") + padAnsi(truncated, innerWidth) + border("│");
	});
	return [top, ...framed, bottom];
}

type TaskOverlayRow = {
	taskIndex: number;
	kind: "header" | "detail";
	text: string;
};

class PrdLoopOverlayComponent {
	private selectedIndex = 0;
	private expanded = new Set<number>();
	private scrollOffset = 0;

	private confirmingAbort = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private state: LoopState,
		private prdTitle: string,
		private onAbort: () => void,
		private onPause: () => void,
		private onOpenViewer: () => void,
		private requestRender: () => void,
	) {
		if (state.tasks.length > 0) this.expanded.add(0);
	}

	focusTask(index: number): void {
		if (this.state.tasks.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(index, this.state.tasks.length - 1));
		this.expanded.add(this.selectedIndex);
	}

	getSelectedTaskIndex(): number {
		return this.selectedIndex;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.confirmingAbort) {
				this.confirmingAbort = false;
				this.onAbort();
				return;
			}
			this.confirmingAbort = true;
			this.requestRender();
			return;
		}
		if (this.confirmingAbort) {
			// Any other key cancels the abort confirmation
			this.confirmingAbort = false;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onPause();
			return;
		}
		if (data === "o" || data === "O") {
			this.onOpenViewer();
			return;
		}

		if (this.state.tasks.length === 0) return;

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.state.tasks.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 5);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.selectedIndex = Math.min(this.state.tasks.length - 1, this.selectedIndex + 5);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, Key.right)) {
			if (this.expanded.has(this.selectedIndex)) this.expanded.delete(this.selectedIndex);
			else this.expanded.add(this.selectedIndex);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.expanded.delete(this.selectedIndex);
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		const maxHeight = Math.max(12, Math.floor((this.tui.terminal.rows || 24) * 0.85));
		const headerLines = this.buildHeader(innerWidth);
		const rows = this.buildTaskRows(innerWidth);
		const footerHeight = 2;
		const contentHeight = Math.max(3, maxHeight - headerLines.length - footerHeight - 2);

		const selectedRowIndex = rows.findIndex((row) => row.taskIndex === this.selectedIndex && row.kind === "header");
		if (selectedRowIndex !== -1) {
			if (selectedRowIndex < this.scrollOffset) this.scrollOffset = selectedRowIndex;
			if (selectedRowIndex >= this.scrollOffset + contentHeight) {
				this.scrollOffset = selectedRowIndex - contentHeight + 1;
			}
		}

		const maxScroll = Math.max(0, rows.length - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleRows = rows
			.slice(this.scrollOffset, this.scrollOffset + contentHeight)
			.map((row) => truncateToWidth(row.text, innerWidth));
		while (visibleRows.length < contentHeight) visibleRows.push("");

		const footerLines = this.buildFooter(innerWidth, rows.length, contentHeight);
		return frameOverlayLines([...headerLines, ...visibleRows, ...footerLines], innerWidth, this.theme)
			.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	private buildHeader(width: number): string[] {
		const now = Date.now();
		const total = this.state.tasks.length;
		const completed = this.state.tasks.filter((task) => task.status === "completed").length;
		const running = this.state.tasks.filter((task) => task.status === "running" || task.status === "retrying").length;
		const failed = this.state.tasks.filter((task) => task.status === "failed").length;
		const currentTask = this.state.tasks[this.state.currentTaskIndex];
		const currentLabel = currentTask
			? `Current: ${currentTask.sequenceLabel} ${extractShortTitle(currentTask.title)}`
			: "Current: —";

		return [
			truncateToWidth(
				this.theme.fg("accent", this.theme.bold("PRD Loop Pro")) + this.theme.fg("muted", ` • ${this.prdTitle}`),
				width,
			),
			truncateToWidth(
				this.theme.fg("muted", `${completed}/${total} done • ${running} active • ${failed} failed • max retries ${this.state.maxRetries}`),
				width,
			),
			truncateToWidth(
				this.theme.fg("dim", `${currentLabel} • $${this.state.totalCost.toFixed(2)} • ${formatElapsed(now - this.state.startTime)}`),
				width,
			),
			"",
		];
	}

	private buildFooter(width: number, totalRows: number, contentHeight: number): string[] {
		const end = Math.min(totalRows, this.scrollOffset + contentHeight);
		const hint = this.confirmingAbort
			? this.theme.fg("warning", "⚠️  Abort loop? Press Esc again to confirm, any other key to cancel")
			: this.theme.fg("dim", "↑↓ select • enter expand • o output • ← collapse • ctrl+c pause • esc abort");
		const scroll = totalRows > contentHeight
			? this.theme.fg("muted", ` ${this.scrollOffset + 1}-${end}/${totalRows}`)
			: "";
		return ["", truncateToWidth(hint + scroll, width)];
	}

	private buildTaskRows(width: number): TaskOverlayRow[] {
		if (this.state.tasks.length === 0) {
			return [{ taskIndex: 0, kind: "detail", text: this.theme.fg("dim", "No tasks to display.") }];
		}

		const rows: TaskOverlayRow[] = [];
		const now = Date.now();

		for (let i = 0; i < this.state.tasks.length; i++) {
			const task = this.state.tasks[i]!;
			const isSelected = i === this.selectedIndex;
			const isExpanded = this.expanded.has(i);
			const prefix = isSelected ? this.theme.fg("accent", "▶") : " ";
			const disclosure = this.theme.fg(isSelected ? "accent" : "dim", isExpanded ? "▾" : "▸");
			const icon = this.theme.fg(taskStatusColor(task.status), statusIcon(task.status));
			const titleText = `Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`;
			const title = isSelected
				? this.theme.fg("accent", this.theme.bold(titleText))
				: this.theme.fg("text", titleText);

			const meta: string[] = [];
			if (task.startTime) {
				const end = task.endTime ?? now;
				meta.push(formatElapsed(end - task.startTime));
			}
			if (task.cost > 0) meta.push(`$${task.cost.toFixed(2)}`);
			if (task.retries > 0) meta.push(`${task.retries} retry${task.retries === 1 ? "" : "s"}`);
			const metaText = meta.length > 0 ? this.theme.fg("dim", ` • ${meta.join(" • ")}`) : "";
			const activePhase = activePhaseLabel(task);
			const phaseText = activePhase ? this.theme.fg("accent", ` • ${activePhase}`) : "";

			rows.push({
				taskIndex: i,
				kind: "header",
				text: truncateToWidth(`${prefix} ${disclosure} ${icon} ${title}${phaseText}${metaText}`, width),
			});

			if (!isExpanded) continue;

			const attemptText = task.status === "retrying"
				? ` • attempt ${task.retries + 1}/${this.state.maxRetries + 1}`
				: "";
			rows.push({
				taskIndex: i,
				kind: "detail",
				text: truncateToWidth(
					this.theme.fg("dim", `    Status: ${task.status}${activePhase ? ` • ${activePhase}` : ""}${attemptText}`),
					width,
				),
			});

			if (task.reviewInfo) {
				rows.push({
					taskIndex: i,
					kind: "detail",
					text: truncateToWidth(this.theme.fg("muted", `    Review: ${task.reviewInfo}`), width),
				});
			}

			if ((task.status === "running" || task.status === "retrying") && task.currentActivity) {
				const turnText = task.currentTurn > 0 ? ` [T${task.currentTurn}]` : "";
				rows.push({
					taskIndex: i,
					kind: "detail",
					text: truncateToWidth(this.theme.fg("muted", `    Activity:${turnText} ${task.currentActivity}`), width),
				});
			}

			if (task.summary) {
				for (const line of wrapTextWithAnsi(this.theme.fg("muted", `    Summary: ${task.summary}`), width)) {
					rows.push({ taskIndex: i, kind: "detail", text: truncateToWidth(line, width) });
				}
			}

			if (task.errors.length > 0) {
				rows.push({
					taskIndex: i,
					kind: "detail",
					text: truncateToWidth(this.theme.fg("error", "    Errors:"), width),
				});
				for (const error of task.errors) {
					for (const line of wrapTextWithAnsi(this.theme.fg("error", `      • ${error}`), width)) {
						rows.push({ taskIndex: i, kind: "detail", text: truncateToWidth(line, width) });
					}
				}
			}
		}

		return rows;
	}
}

/** Final outcome of a loop run (`released` = a task was released to a human). */
type LoopOutcome = "completed" | "failed" | "aborted" | "released";

/**
 * Build the final summary widget lines.
 */
function buildSummaryWidget(
	state: LoopState,
	prdTitle: string,
	outcome: LoopOutcome,
): string[] {
	const width = process.stdout.columns || 80;
	const lines: string[] = [];

	const outcomeIcon = { completed: "✅", failed: "❌", aborted: "⚠️", released: "🔧" }[outcome];
	const outcomeText = {
		completed: "Loop completed",
		failed: "Loop failed",
		aborted: "Loop aborted",
		released: "Loop stopped — task released to a human (needs-human)",
	}[outcome];
	lines.push(`${outcomeIcon} ${prdTitle} — ${outcomeText}`);
	lines.push("");

	for (const task of state.tasks) {
		const icon = statusIcon(task.status);
		const label = `Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`;

		let timePart = "     ";
		if (task.endTime && task.startTime) {
			timePart = formatElapsed(task.endTime - task.startTime).padStart(5);
		}

		const costPart = task.cost > 0 ? `  $${task.cost.toFixed(2)}` : "";
		const retryPart = task.retries > 0 ? `  (${task.retries} retry${task.retries > 1 ? "s" : ""})` : "";

		lines.push(`${label}  ${icon}  ${timePart}${costPart}${retryPart}`);
	}

	lines.push("");

	const totalElapsed = formatElapsed((state.tasks.at(-1)?.endTime ?? Date.now()) - state.startTime);
	const totalRetries = state.tasks.reduce((sum, t) => sum + t.retries, 0);
	const parts = [
		`Total: ${totalElapsed}`,
		`$${state.totalCost.toFixed(2)}`,
		`${totalRetries} retry${totalRetries !== 1 ? "s" : ""}`,
		`${state.totalCommits} commit${state.totalCommits !== 1 ? "s" : ""}`,
	];
	lines.push(parts.join(" | "));

	return lines.map((line) => truncateToWidth(line, width));
}

/**
 * Print the final summary as static text to the session output.
 */
function printSummary(
	ctx: ExtensionCommandContext,
	state: LoopState,
	prdTitle: string,
	outcome: LoopOutcome,
): void {
	const lines = buildSummaryWidget(state, prdTitle, outcome);
	ctx.ui.setWidget("prd-loop-pro-summary", lines);
}

// --- Subagent Output Viewer Overlay ---

/**
 * Overlay component that shows live subagent output for a running task.
 *
 * Renders a bordered, scrollable log of tool calls, results, thinking, and text output.
 * Auto-scrolls to bottom unless the user manually scrolls up.
 * Refreshed periodically via an external setInterval + tui.requestRender().
 */
class SubagentOutputViewer {
	private tui: TUI;
	private theme: Theme;
	private taskState: LoopTaskState;
	private onClose: (reason: "escape" | "pause") => void;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private autoScroll = true;
	private prevEventCount = 0;

	constructor(tui: TUI, theme: Theme, taskState: LoopTaskState, onClose: (reason: "escape" | "pause") => void) {
		this.tui = tui;
		this.theme = theme;
		this.taskState = taskState;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onClose("escape");
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose("pause");
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.autoScroll = false;
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollBy(1);
			const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
			if (this.scrollOffset >= maxScroll) this.autoScroll = true;
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) {
			this.autoScroll = false;
			this.scrollBy(-(this.viewHeight || 10));
			return;
		}
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right)) {
			this.scrollBy(this.viewHeight || 10);
			const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
			if (this.scrollOffset >= maxScroll) this.autoScroll = true;
			return;
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const task = this.taskState;
		const maxHeight = this.getMaxHeight();
		const headerLines = 3;
		const footerLines = 2;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const eventLines = this.formatEvents(innerWidth);
		this.totalLines = eventLines.length;
		this.viewHeight = contentHeight;

		if (this.autoScroll || task.outputEvents.length !== this.prevEventCount) {
			if (this.autoScroll) {
				this.scrollOffset = Math.max(0, this.totalLines - contentHeight);
			}
			this.prevEventCount = task.outputEvents.length;
		}

		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = eventLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];

		lines.push(this.buildTitleLine(innerWidth));
		lines.push(this.buildMetaLine(innerWidth));
		lines.push("");

		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}

		lines.push("");
		lines.push(this.buildHintLine(innerWidth));

		const borderColor = (text: string) => theme.fg("borderMuted", text);
		const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		});

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// No caching — always renders fresh from outputEvents
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.85));
	}

	private formatEvents(maxWidth: number): string[] {
		const theme = this.theme;
		const events = this.taskState.outputEvents;
		if (events.length === 0) {
			return [theme.fg("muted", "  Waiting for subagent output…")];
		}

		const lines: string[] = [];
		for (const ev of events) {
			const turnLabel = theme.fg("dim", `T${ev.turn}`);
			switch (ev.kind) {
				case "tool_start": {
					const toolName = theme.fg("toolTitle", theme.bold(ev.tool ?? "?"));
					const args = ev.args ? theme.fg("muted", ` ${ev.args}`) : "";
					lines.push(truncateToWidth(`  ${turnLabel} ▶ ${toolName}${args}`, maxWidth));
					break;
				}
				case "tool_end": {
					const icon = ev.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const toolName = ev.error
						? theme.fg("error", ev.tool ?? "?")
						: theme.fg("success", ev.tool ?? "?");
					lines.push(truncateToWidth(`  ${turnLabel} ${icon} ${toolName}`, maxWidth));
					if (ev.result) {
						const previewLines = ev.result.split("\n").slice(0, 3);
						for (const pLine of previewLines) {
							const sanitized = pLine.replace(/\t/g, " ");
							lines.push(truncateToWidth(`       ${theme.fg("dim", sanitized)}`, maxWidth));
						}
					}
					break;
				}
				case "thinking":
					lines.push(truncateToWidth(`  ${turnLabel} ${theme.fg("muted", "🧠 thinking…")}`, maxWidth));
					break;
				case "text":
					lines.push(truncateToWidth(`  ${turnLabel} ${theme.fg("muted", "💬 writing response…")}`, maxWidth));
					break;
			}
		}
		return lines;
	}

	private buildTitleLine(width: number): string {
		const theme = this.theme;
		const task = this.taskState;
		const titleText = ` Task ${task.sequenceLabel}: ${extractShortTitle(task.title)} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			theme.fg("borderMuted", "─".repeat(leftWidth)) +
			theme.fg("accent", titleText) +
			theme.fg("borderMuted", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		const theme = this.theme;
		const task = this.taskState;
		const now = Date.now();

		const icon = task.status === "running" ? "🔄" : task.status === "retrying" ? "🔁" : statusIconFn(task.status);
		const elapsed = task.startTime ? formatElapsed(now - task.startTime) : "0:00";
		const turnInfo = task.currentTurn > 0 ? `T${task.currentTurn}` : "";
		const eventCount = `${task.outputEvents.length} events`;

		const phaseLabel = activePhaseLabel(task);
		const phase = phaseLabel ? ` • ${phaseLabel}` : "";
		const line =
			theme.fg("accent", `${icon} ${task.status}${phase}`) +
			theme.fg("muted", " • ") +
			theme.fg("muted", elapsed) +
			(turnInfo ? theme.fg("muted", ` • ${turnInfo}`) : "") +
			theme.fg("muted", ` • ${eventCount}`);
		return truncateToWidth(line, width);
	}

	private buildHintLine(width: number): string {
		const theme = this.theme;
		const nav = theme.fg("dim", "↑/↓ scroll • ←/→ page • Esc close • Ctrl+C pause");
		let line = nav;
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			const scrollInfo = theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
			line += scrollInfo;
		}
		if (this.autoScroll) {
			line += theme.fg("muted", " (auto-scroll)");
		}
		return truncateToWidth(line, width);
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}
}

/** statusIcon wrapper to avoid name collision with the existing function */
function statusIconFn(status: TaskStatus): string {
	return statusIcon(status);
}

// --- Pause menu ---

type PauseAction = "resume" | "release" | "retry" | "retry-commit" | "skip" | "abort";

/**
 * Label of the "Release" option: the task todo is set to `needs-human`, the
 * open findings are appended to it and the loop stops. The task is offered
 * first at the next start.
 */
const RELEASE_LABEL = "🔧 Release (fix manually) — mark task needs-human, stop the loop, resolve at next start";

/**
 * Show an interactive pause menu (after Ctrl+C interrupts a running subagent
 * or when a phase fails, e.g. committer failure / pre-commit hook failure).
 * Cancelling the dialog selects the first offered action.
 */
async function showPauseMenu(
	ctx: ExtensionCommandContext,
	task: TaskInfo,
	options: { phase?: TaskPhase; actions?: PauseAction[]; reason?: string } = {},
): Promise<PauseAction> {
	const phase = options.phase ?? "Implement";
	const actions = options.actions ?? ["resume", "release", "retry", "skip", "abort"];
	const labels: Record<PauseAction, string> = {
		resume: phase === "Implement"
			? "▶️  Resume — keep changes, continue where it left off"
			: `▶️  Resume — keep changes, restart the ${phase.toLowerCase()} phase`,
		release: RELEASE_LABEL,
		retry: "🔄 Retry task — discard changes, try again from scratch",
		"retry-commit": "🔁 Retry commit — run the committer again",
		skip: "⏭️  Skip task — discard changes, mark done, continue with next",
		abort: "❌ Abort loop — stop and keep changes on disk",
	};
	const menu = actions.map((action) => labels[action]);

	const choice = await ctx.ui.select(
		`⏸️  Paused (${phase}${options.reason ? `: ${options.reason}` : ""}) — Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`,
		menu,
	);

	const index = choice === undefined ? -1 : menu.indexOf(choice);
	return index === -1 ? actions[0]! : actions[index]!;
}

type RoundLimitAction = "one-more-round" | "commit-as-is" | "release" | "skip" | "abort";

/** Maximum number of open findings listed in the round-limit menu title. */
const ROUND_LIMIT_MAX_LISTED_FINDINGS = 12;

/** One line per open finding: `[P1] file:line — title`. */
export function formatOpenFindingLine(finding: ReviewFinding): string {
	const location = formatLocation(finding) || "(no file)";
	const title = finding.title.replace(/\s+/g, " ").trim() || "(untitled)";
	return `[${finding.priority}] ${location} — ${title}`;
}

/**
 * Pause menu shown when the review round limit is reached with open findings
 * at/above the fix threshold. Lists the open findings (priority, file:line,
 * title). Cancelling the dialog shows it again (every option has a cost or
 * consequence, so none is chosen implicitly).
 */
async function showRoundLimitMenu(
	ctx: ExtensionCommandContext,
	task: TaskInfo,
	step: Extract<CycleStep, { kind: "pause" }>,
): Promise<RoundLimitAction> {
	const count = step.openFindings.length;
	const listed = step.openFindings.slice(0, ROUND_LIMIT_MAX_LISTED_FINDINGS);
	const titleLines = [
		`⏸️  Review round limit reached (${step.round}/${step.roundLimit}) — Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`,
		"",
		`${count} open finding${count === 1 ? "" : "s"} at/above the fix threshold:`,
		...listed.map((finding) => `  ${formatOpenFindingLine(finding)}`),
	];
	if (count > listed.length) titleLines.push(`  … and ${count - listed.length} more`);

	const actions: RoundLimitAction[] = ["one-more-round", "commit-as-is", "release", "skip", "abort"];
	const labels: Record<RoundLimitAction, string> = {
		"one-more-round": "🔁 One more round — fix the open findings and review again",
		"commit-as-is": "✅ Commit as-is & close task — open findings go into the report",
		release: RELEASE_LABEL,
		skip: "⏭️  Skip task — discard changes, mark done, continue with next",
		abort: "❌ Abort loop — stop and keep changes on disk",
	};
	const menu = actions.map((action) => labels[action]);

	while (true) {
		const choice = await ctx.ui.select(titleLines.join("\n"), menu);
		const index = choice === undefined ? -1 : menu.indexOf(choice);
		if (index !== -1) return actions[index]!;
	}
}

/** One-line review-fix cycle status for the task details. */
function formatCycleInfo(cycle: ReviewCycleState): string {
	const counts = cycleCounts(cycle);
	const last = cycle.rounds.at(-1);
	const parts = [`round ${counts.round}/${counts.roundLimit}`];
	if (last) parts.push(last.verdict);
	parts.push(
		`${counts.fixed} fixed, ${counts.rejected} rejected, ${counts.deferred} deferred, ${counts.unresolved} unresolved`,
	);
	const callouts = cycle.callouts.length;
	if (callouts > 0) parts.push(`${callouts} callout${callouts === 1 ? "" : "s"}`);
	return parts.join(" • ");
}

// --- Git helpers ---

/** Current HEAD commit SHA, or null if the repository has no commits yet. */
async function getHeadSha(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd });
	if (result.code !== 0) return null;
	const sha = result.stdout.trim();
	return sha || null;
}

/**
 * Commits created since `before` (oldest first). With `before === null`
 * (no commits before), all commits reachable from HEAD are returned.
 */
async function listCommitsSince(pi: ExtensionAPI, cwd: string, before: string | null): Promise<CommitRef[]> {
	const after = await getHeadSha(pi, cwd);
	if (!after || after === before) return [];
	const range = before ? `${before}..${after}` : after;
	const result = await pi.exec("git", ["log", "--reverse", "--format=%h%x09%s", range], { cwd });
	if (result.code !== 0) {
		throw new Error(`git log ${range} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			return tab === -1 ? { sha: line.trim() } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
		});
}

/**
 * Files under `.pi/` touched by the commits created since `before`
 * (with `before === null`, all commits reachable from HEAD).
 */
async function listExcludedFilesCommittedSince(pi: ExtensionAPI, cwd: string, before: string | null): Promise<string[]> {
	const after = await getHeadSha(pi, cwd);
	if (!after || after === before) return [];
	const range = before ? `${before}..${after}` : after;
	const result = await pi.exec("git", ["log", "--format=", "--name-only", range, "--", REVIEW_EXCLUDED_DIR], { cwd });
	if (result.code !== 0) {
		throw new Error(`git log ${range} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return [...new Set(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
}

// --- Orchestrator loop ---

/**
 * Run the orchestrator loop: resolve tasks, spawn subagents, commit, update todos.
 *
 * Features:
 * - Live overlay with task navigation and expandable details
 * - Output viewer overlay for the currently selected task
 * - Ctrl+C pauses the current subagent and opens the pause menu
 * - Commits via prd-committer subagent (commit model/thinking from settings)
 * - "Release (fix manually)": task todo → `needs-human` + open findings, loop stops
 * - Resolving a `needs-human` task (`options.resume`): the task runs first,
 *   starting at the commit phase ("Commit changes & close") or the review-fix
 *   cycle ("Review again") with the current uncommitted changes
 * - `needs-human` tasks (not being resolved) and their dependents are never started
 * - Final summary widget on completion/failure/abort/release
 */
async function runOrchestratorLoop(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	prd: TodoItem,
	prdTag: string,
	settings: PrdLoopProSettings,
	commitRules: string,
	options: { resume?: NeedsHumanResume } = {},
): Promise<void> {
	const agent = await loadPrdWorkerAgent(EXTENSION_DIR);
	const reviewerAgent = await loadAgent(EXTENSION_DIR, "prd-reviewer");
	const fixerAgent = await loadAgent(EXTENSION_DIR, "prd-fixer");
	const committerAgent = await loadAgent(EXTENSION_DIR, "prd-committer");
	const prdId = prd.id.startsWith("TODO-") ? prd.id : `TODO-${prd.id}`;
	const tasks = await fetchPrdTasks(ctx.cwd, prdTag);
	const resume = options.resume && tasks.some((t) => t.id === options.resume!.taskId && isNeedsHuman(t.status))
		? options.resume
		: undefined;
	const resolution = resolveTaskOrder(tasks, { resolvingTaskId: resume?.taskId });

	// Sync PRD Task Index with actual todo statuses (picks up tasks closed outside the loop)
	try {
		await syncPrdTaskIndexFile(ctx.cwd, prdId, tasks);
	} catch (err) {
		ctx.ui.notify(
			`⚠️ Failed to sync PRD Task Index: ${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
	}

	if (resolution.error) {
		ctx.ui.notify(resolution.error, "error");
		return;
	}

	if (resolution.actionable.length === 0) {
		if (resolution.held.length > 0) {
			ctx.ui.notify(`No actionable tasks. ${formatHeldTasks(resolution.held)}`, "warning");
			return;
		}
		ctx.ui.notify("All tasks already completed.", "info");
		if (!isTaskClosed(prd.status)) {
			await updateTodoFileStatus(ctx.cwd, prdId, "closed");
		}
		return;
	}

	const allTasksSorted = [...resolution.allTasks].sort((a, b) => {
		const aNum = parseFloat(a.sequenceLabel.split("/")[0]) || 999;
		const bNum = parseFloat(b.sequenceLabel.split("/")[0]) || 999;
		if (aNum !== bNum) return aNum - bNum;
		return a.title.localeCompare(b.title);
	});

	const loopState: LoopState = {
		startTime: Date.now(),
		tasks: allTasksSorted.map((task) => ({
			id: task.id,
			title: task.title,
			sequenceLabel: task.sequenceLabel,
			status: (isTaskClosed(task.status) ? "completed" : isNeedsHuman(task.status) ? "needs-human" : "pending") as TaskStatus,
			cost: 0,
			retries: 0,
			errors: [],
			summary: undefined,
			currentActivity: undefined,
			currentTurn: 0,
			outputEvents: [],
		})),
		totalCost: 0,
		totalCommits: 0,
		currentTaskIndex: 0,
		currentRetry: 0,
		maxRetries: settings.implementationRetries,
	};

	const prdTitle = prd.title;
	let currentAbortController = new AbortController();
	let aborted = false;
	let pauseRequested = false;
	let viewerOpen = false;
	let overlayClosed = false;
	let overlayDone: ((reason: "finished" | "user-abort") => void) | undefined;
	let overlayRequestRender = () => {};
	let overlayComponent: PrdLoopOverlayComponent | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;

	const requestOverlayRender = () => {
		if (!overlayClosed && !viewerOpen) overlayRequestRender();
	};
	const closeOverlay = (reason: "finished" | "user-abort") => {
		if (overlayClosed) return;
		overlayClosed = true;
		overlayDone?.(reason);
	};
	const updateStatus = () => {
		const currentTask = loopState.tasks[loopState.currentTaskIndex];
		const currentPhase = currentTask ? activePhaseLabel(currentTask) : undefined;
		const phaseText = currentPhase ? ` [${currentPhase}]` : "";
		const statusText = currentTask
			? `Ralph Pro: ${currentTask.sequenceLabel} ${extractShortTitle(currentTask.title)}${phaseText}`
			: "Ralph Pro running";
		ctx.ui.setStatus("prd-loop-pro", statusText);
	};

	const openOutputViewer = async () => {
		if (viewerOpen) return;
		const selectedTaskIndex = overlayComponent?.getSelectedTaskIndex() ?? loopState.currentTaskIndex;
		const selectedTask = loopState.tasks[selectedTaskIndex] ?? loopState.tasks[loopState.currentTaskIndex];
		if (!selectedTask) return;

		viewerOpen = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const refreshTimer = setInterval(() => tui.requestRender(), 500);
					const viewer = new SubagentOutputViewer(tui, theme, selectedTask, (reason) => {
						clearInterval(refreshTimer);
						if (reason === "pause") {
							pauseRequested = true;
							currentAbortController.abort();
						}
						done();
					});
					return viewer;
				},
				{
					overlay: true,
					overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
				},
			);
		} finally {
			viewerOpen = false;
			requestOverlayRender();
		}
	};

	ctx.ui.setWidget("prd-loop-pro", undefined);
	updateStatus();

	const overlayPromise = ctx.ui.custom<"finished" | "user-abort" | undefined>(
		(tui, theme, _keybindings, done) => {
			overlayDone = done;
			overlayRequestRender = () => tui.requestRender();
			overlayComponent = new PrdLoopOverlayComponent(
				tui,
				theme,
				loopState,
				prdTitle,
				() => {
					if (!aborted) {
						aborted = true;
						currentAbortController.abort();
					}
					if (widgetTimer) clearInterval(widgetTimer);
					closeOverlay("user-abort");
				},
				() => {
					pauseRequested = true;
					currentAbortController.abort();
				},
				() => {
					void openOutputViewer();
				},
				() => {
					if (!overlayClosed && !viewerOpen) tui.requestRender();
				},
			);
			return overlayComponent;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "90%",
				maxHeight: "88%",
				margin: 0,
			},
		},
	);

	type LoopRunResult = {
		outcome: LoopOutcome;
		notification?: { message: string; level: "info" | "warning" | "error" };
		unexpectedError?: unknown;
	};

	// --- Pipeline helpers ---

	/** Switch a task to a new pipeline phase (resets the live activity). */
	const setPhase = (taskState: LoopTaskState, phase: TaskPhase, label?: string) => {
		taskState.phase = phase;
		taskState.phaseLabel = label;
		taskState.currentActivity = undefined;
		taskState.currentTurn = 0;
		updateStatus();
		requestOverlayRender();
	};

	/** Live activity handler for a subagent working on `taskState`. */
	const createActivityHandler = (taskState: LoopTaskState) => (activity: SubagentActivity) => {
		taskState.currentTurn = activity.turn;

		switch (activity.type) {
			case "tool_start":
				taskState.currentActivity = `▶ ${activity.toolName}${activity.argsSummary ? ` ${activity.argsSummary}` : ""}`;
				break;
			case "tool_end":
				taskState.currentActivity = `${activity.toolSuccess ? "✓" : "✗"} ${activity.toolName}`;
				break;
			case "text_delta":
				taskState.currentActivity = "💬 writing response…";
				break;
			case "thinking":
				taskState.currentActivity = "🧠 thinking…";
				break;
		}

		appendOutputEvent(taskState.outputEvents, activity);
		requestOverlayRender();
	};

	/**
	 * LLM repair factory for `parseRunResult`: one repair attempt with the
	 * orchestrator model/thinking level, bound to the current abort signal.
	 */
	const createRepairFactory = (taskState: LoopTaskState) => {
		const repairSignal = currentAbortController.signal;
		return (onCost: (cost: number) => void): RepairFunction => {
			const repair = createOrchestratorRepair(ctx.modelRegistry, settings.steps.orchestrator, {
				signal: repairSignal,
				onCost,
			});
			return async (request) => {
				taskState.currentActivity = "🔧 repairing JSON result…";
				requestOverlayRender();
				return repair(request);
			};
		};
	};

	/** Book cost on the task, the loop total and the per-phase breakdown. */
	const addCost = (
		taskState: LoopTaskState,
		phaseCosts: Partial<Record<CostPhase, number>>,
		phase: CostPhase,
		cost: number,
	) => {
		taskState.cost += cost;
		loopState.totalCost += cost;
		phaseCosts[phase] = (phaseCosts[phase] ?? 0) + cost;
		requestOverlayRender();
	};

	/** Discard all uncommitted changes (tracked + untracked). */
	const discardChanges = async () => {
		await pi.exec("git", ["checkout", "."], { cwd: ctx.cwd });
		await pi.exec("git", ["clean", "-fd"], { cwd: ctx.cwd });
	};

	/** Close a task todo and update the PRD Task Index (index errors are reported, not fatal). */
	const closeTaskAndUpdateIndex = async (task: TaskInfo, options: { notifyIndexError: boolean }) => {
		await updateTodoFileStatus(ctx.cwd, task.id, "closed");
		task.status = "closed";
		try {
			await syncPrdTaskIndexFile(ctx.cwd, prdId, tasks);
		} catch (err) {
			if (options.notifyIndexError) {
				ctx.ui.notify(
					`⚠️ Failed to update PRD Task Index: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		}
	};

	/** Skip a task after a pause: discard changes and close the todo. */
	const skipTask = async (task: TaskInfo, taskState: LoopTaskState, summary = "Skipped after manual pause.") => {
		await discardChanges();
		currentAbortController = new AbortController();
		taskState.status = "completed";
		taskState.endTime = Date.now();
		taskState.currentActivity = undefined;
		taskState.summary = summary;
		taskState.errors = [];
		await closeTaskAndUpdateIndex(task, { notifyIndexError: false });
	};

	/** Why and with which open findings a task is released to a human. */
	type ReleaseRequest = {
		reason: string;
		errors?: string[];
		/** Review-fix cycle state at the release point (undefined during implementation). */
		cycle?: ReviewCycleState;
		/** Status text for findings of the last round that no fixer processed yet. */
		openReason?: string;
	};

	/**
	 * "Release (fix manually)": append the open findings section (incl. the
	 * reason and errors) to the task todo, set its status to `needs-human`,
	 * update the PRD Task Index and stop the loop. Uncommitted changes stay on
	 * disk; the task is offered first at the next start.
	 */
	const releaseTask = async (task: TaskInfo, taskState: LoopTaskState, request: ReleaseRequest): Promise<LoopRunResult> => {
		const cycle = request.cycle;
		const lastRound = cycle?.rounds.at(-1)?.round;
		const open: UnresolvedFinding[] = cycle
			? [
				...unresolvedFindings(cycle),
				...openFindings(cycle).map((finding) => ({
					finding,
					reason: request.openReason ?? "Not processed before the release",
					round: lastRound,
				})),
			]
			: [];
		const rejected = cycle ? rejectedForNextReview(cycle) : [];

		const body = await readTodoBody(ctx.cwd, task.id);
		const section = buildOpenFindingsSection(open, rejected, { reason: request.reason, errors: request.errors });
		await updateTodoFileBody(ctx.cwd, task.id, appendSection(body, section));
		await updateTodoFileStatus(ctx.cwd, task.id, NEEDS_HUMAN_STATUS);
		task.status = NEEDS_HUMAN_STATUS;
		try {
			await syncPrdTaskIndexFile(ctx.cwd, prdId, tasks);
		} catch (err) {
			ctx.ui.notify(
				`⚠️ Failed to update PRD Task Index: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}

		currentAbortController = new AbortController();
		taskState.status = "needs-human";
		taskState.endTime = Date.now();
		taskState.currentActivity = undefined;
		taskState.summary = `Released to a human: ${request.reason}`;
		requestOverlayRender();

		const findingsText = open.length > 0
			? `${open.length} open finding${open.length === 1 ? "" : "s"} appended to ${task.id}.`
			: `Release details appended to ${task.id}.`;
		return {
			outcome: "released",
			notification: {
				message:
					`🔧 Task ${task.sequenceLabel} released to a human (needs-human): ${request.reason}.\n` +
					`${findingsText} Uncommitted changes left on disk; dependent tasks stay blocked.\n` +
					"Fix it manually (or with the main agent), then re-run /prd-loop-pro to commit & close it " +
					"(or just close it if already committed, or review again) and continue with the next task.",
				level: "warning",
			},
		};
	};

	type ReviewPhaseOutcome =
		| { kind: "reviewed"; review: ReviewerResult }
		| { kind: "no-changes" }
		| { kind: "skipped" }
		| { kind: "released"; reason: string }
		| { kind: "aborted" }
		| { kind: "failed"; error: string };

	/**
	 * Review phase: one fresh prd-reviewer subagent (review model/thinking)
	 * reviews the uncommitted changes outside `.pi/` against the task. The
	 * result is parsed and, if needed, repaired with the reviewer schema.
	 */
	const runReviewPhase = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phaseCosts: Partial<Record<CostPhase, number>>,
		options: { round: number; rejectedFindings: RejectedFinding[] },
	): Promise<ReviewPhaseOutcome> => {
		const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all", ...REVIEW_PATHSPEC], { cwd: ctx.cwd });
		if (status.code !== 0) {
			return { kind: "failed", error: `git status failed: ${(status.stderr || status.stdout).trim()}` };
		}
		const changedFiles = filterReviewableStatus(status.stdout);
		if (changedFiles.length === 0) return { kind: "no-changes" };

		const prompt = buildReviewerPrompt({
			taskTitle: task.title,
			taskBody: task.body,
			changedFiles,
			projectGuidelines: await loadProjectReviewGuidelines(ctx.cwd),
			rejectedFindings: options.rejectedFindings,
			round: options.round,
		});

		while (true) {
			if (aborted) return { kind: "aborted" };

			const run = await spawnSubagent({
				taskPrompt: prompt,
				model: settings.steps.review.model,
				thinkingLevel: settings.steps.review.thinking,
				cwd: ctx.cwd,
				agent: reviewerAgent,
				signal: currentAbortController.signal,
				onActivity: createActivityHandler(taskState),
			});
			const parsed = await parseRunResult(run, REVIEWER_RESULT_SCHEMA, createRepairFactory(taskState));
			addCost(taskState, phaseCosts, "review", parsed.usage.cost);

			if (pauseRequested) {
				pauseRequested = false;
				if (widgetTimer) clearInterval(widgetTimer);
				const pauseAction = await showPauseMenu(ctx, task, {
					phase: "Review",
					actions: ["resume", "release", "skip", "abort"],
				});
				widgetTimer = setInterval(requestOverlayRender, 1000);

				switch (pauseAction) {
					case "resume":
						currentAbortController = new AbortController();
						taskState.currentActivity = "▶ restarting review…";
						requestOverlayRender();
						continue;
					case "release":
						return { kind: "released", reason: "manual pause during review" };
					case "skip":
						await skipTask(task, taskState);
						requestOverlayRender();
						return { kind: "skipped" };
					case "retry": // not offered during review
					case "abort":
						aborted = true;
						return { kind: "aborted" };
				}
			}

			if (aborted) return { kind: "aborted" };
			if (!parsed.ok) return { kind: "failed", error: parsed.error };
			return { kind: "reviewed", review: parsed.value };
		}
	};

	type FixPhaseOutcome =
		| { kind: "result"; outcome: FixOutcome }
		| { kind: "skipped" }
		| { kind: "released"; reason: string }
		| { kind: "aborted" };

	/**
	 * Fix phase for exactly one finding: a fresh prd-fixer subagent (fix
	 * model/thinking) gets the task title/body and the finding, fixes it (and
	 * runs the relevant checks) or rejects it with a reason. A crashed fixer or
	 * an unparseable result (even after JSON repair) counts the finding as
	 * unresolved — it never stops the loop.
	 */
	const runFixPhase = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phaseCosts: Partial<Record<CostPhase, number>>,
		step: Extract<CycleStep, { kind: "fix" }>,
	): Promise<FixPhaseOutcome> => {
		const prompt = buildFixerPrompt({
			taskTitle: task.title,
			taskBody: task.body,
			finding: step.finding,
			round: step.round,
			prdId,
		});

		while (true) {
			if (aborted) return { kind: "aborted" };

			const run = await spawnSubagent({
				taskPrompt: prompt,
				model: settings.steps.fix.model,
				thinkingLevel: settings.steps.fix.thinking,
				cwd: ctx.cwd,
				agent: fixerAgent,
				signal: currentAbortController.signal,
				onActivity: createActivityHandler(taskState),
			});
			const parsed = await parseRunResult(run, FIXER_RESULT_SCHEMA, createRepairFactory(taskState));
			addCost(taskState, phaseCosts, "fix", parsed.usage.cost);

			if (pauseRequested) {
				pauseRequested = false;
				if (widgetTimer) clearInterval(widgetTimer);
				const pauseAction = await showPauseMenu(ctx, task, {
					phase: "Fix",
					actions: ["resume", "release", "skip", "abort"],
				});
				widgetTimer = setInterval(requestOverlayRender, 1000);

				switch (pauseAction) {
					case "release":
						return { kind: "released", reason: "manual pause during fix" };
					case "skip":
						await skipTask(task, taskState);
						requestOverlayRender();
						return { kind: "skipped" };
					case "abort":
						aborted = true;
						return { kind: "aborted" };
					default:
						currentAbortController = new AbortController();
						taskState.currentActivity = "▶ restarting fix…";
						requestOverlayRender();
						continue;
				}
			}

			if (aborted) return { kind: "aborted" };

			if (!parsed.ok) {
				const what = parsed.status === "invalid-result" ? "returned no valid result" : parsed.status === "aborted" ? "was aborted" : "crashed";
				return {
					kind: "result",
					outcome: { status: "unresolved", reason: `Fixer ${what}: ${truncateStr(parsed.error, 300)}` },
				};
			}

			const value = parsed.value;
			if (value.status === "fixed") {
				const summary = [value.summary || value.reason, value.verification ? `Verification: ${value.verification}` : ""]
					.filter((part) => part.trim())
					.join(" — ");
				return { kind: "result", outcome: { status: "fixed", summary, verification: value.verification } };
			}
			return { kind: "result", outcome: { status: "rejected", reason: value.reason || value.summary, summary: value.summary } };
		}
	};

	type CommitPhaseOutcome =
		| { kind: "committed"; commits: CommitRef[] }
		| { kind: "skipped" }
		| { kind: "released"; reason: string; errors?: string[] }
		| { kind: "aborted" };

	/**
	 * Commit phase: a prd-committer subagent (commit model/thinking) commits the
	 * uncommitted changes outside `.pi/` following the `/commit` prompt template
	 * rules. There is no fallback commit: committer failure, a failing hook
	 * (`hookFailed`), an unparseable result, leftover changes or commits touching
	 * `.pi/` pause the loop with "Retry commit" / "Skip task" / "Abort".
	 *
	 * HEAD is recorded before the phase; the created commits (SHA + subject) are
	 * determined by the orchestrator, not by the agent.
	 */
	const runCommitPhase = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phaseCosts: Partial<Record<CostPhase, number>>,
	): Promise<CommitPhaseOutcome> => {
		const headBefore = await getHeadSha(pi, ctx.cwd);

		while (true) {
			if (aborted) return { kind: "aborted" };

			let errors: string[] = [];
			let hookFailed = false;

			const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all", ...REVIEW_PATHSPEC], { cwd: ctx.cwd });
			if (status.code !== 0) {
				errors = [`git status failed: ${(status.stderr || status.stdout).trim()}`];
			} else {
				const changedFiles = filterReviewableStatus(status.stdout);
				if (changedFiles.length > 0) {
					taskState.currentActivity = undefined;
					taskState.currentTurn = 0;
					const run = await spawnSubagent({
						taskPrompt: buildCommitterPrompt({ commitRules, taskTitle: task.title, changedFiles }),
						model: settings.steps.commit.model,
						thinkingLevel: settings.steps.commit.thinking,
						cwd: ctx.cwd,
						agent: committerAgent,
						signal: currentAbortController.signal,
						onActivity: createActivityHandler(taskState),
					});
					const parsed = await parseRunResult(run, COMMITTER_RESULT_SCHEMA, createRepairFactory(taskState));
					addCost(taskState, phaseCosts, "commit", parsed.usage.cost);

					if (pauseRequested) {
						pauseRequested = false;
						if (widgetTimer) clearInterval(widgetTimer);
						// "Skip phase" is never offered during commit: uncommitted changes
						// would leak into the next task.
						const pauseAction = await showPauseMenu(ctx, task, {
							phase: "Commit",
							actions: ["retry-commit", "release", "skip", "abort"],
						});
						widgetTimer = setInterval(requestOverlayRender, 1000);

						switch (pauseAction) {
							case "release":
								return { kind: "released", reason: "manual pause during commit" };
							case "skip":
								await skipTask(task, taskState);
								requestOverlayRender();
								return { kind: "skipped" };
							case "abort":
								aborted = true;
								return { kind: "aborted" };
							default:
								currentAbortController = new AbortController();
								taskState.currentActivity = "▶ restarting commit…";
								requestOverlayRender();
								continue;
						}
					}

					if (aborted) return { kind: "aborted" };

					if (!parsed.ok) {
						errors = [`Committer returned no valid result: ${parsed.error}`];
					} else if (parsed.value.hookFailed) {
						hookFailed = true;
						errors = parsed.value.errors.length > 0 ? parsed.value.errors : [parsed.value.summary || "Git hook failed"];
					} else if (!parsed.value.success) {
						errors = parsed.value.errors.length > 0 ? parsed.value.errors : [parsed.value.summary || "Committer failed"];
					}
				}

				// Verify the result independently of what the agent reported.
				if (errors.length === 0) {
					try {
						const excluded = await listExcludedFilesCommittedSince(pi, ctx.cwd, headBefore);
						if (excluded.length > 0) {
							errors = [`Commits include files under ${REVIEW_EXCLUDED_DIR}/: ${excluded.join(", ")}`];
						}
					} catch (err) {
						errors = [err instanceof Error ? err.message : String(err)];
					}
				}
				if (errors.length === 0 && changedFiles.length > 0) {
					const after = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all", ...REVIEW_PATHSPEC], { cwd: ctx.cwd });
					const remaining = after.code === 0 ? filterReviewableStatus(after.stdout) : [];
					if (remaining.length > 0) {
						errors = [`Uncommitted changes remain after the commit phase: ${remaining.map((line) => line.slice(3)).join(", ")}`];
					}
				}
			}

			if (errors.length === 0) {
				taskState.errors = [];
				return { kind: "committed", commits: await listCommitsSince(pi, ctx.cwd, headBefore) };
			}

			// --- Pause: committer failed or a hook rejected the commit (never bypassed) ---
			const reason = hookFailed ? "git hook failed" : "committer failed";
			taskState.errors = errors;
			taskState.currentActivity = `⏸ ${reason}`;
			requestOverlayRender();
			if (widgetTimer) clearInterval(widgetTimer);
			ctx.ui.notify(
				`⚠️ Commit phase paused (${reason}) — Task ${task.sequenceLabel}:\n${errors.join("\n")}`,
				"warning",
			);
			const pauseAction = await showPauseMenu(ctx, task, {
				phase: "Commit",
				reason,
				actions: ["retry-commit", "release", "skip", "abort"],
			});
			widgetTimer = setInterval(requestOverlayRender, 1000);

			switch (pauseAction) {
				case "release":
					return { kind: "released", reason, errors };
				case "skip":
					await skipTask(task, taskState, `Skipped after commit failure (${reason}).`);
					requestOverlayRender();
					return { kind: "skipped" };
				case "abort":
					aborted = true;
					return { kind: "aborted" };
				default:
					currentAbortController = new AbortController();
					taskState.errors = [];
					taskState.currentActivity = "▶ retrying commit…";
					requestOverlayRender();
					continue;
			}
		}
	};

	const runPromise = (async (): Promise<LoopRunResult> => {
		widgetTimer = setInterval(requestOverlayRender, 1000);

		try {
			for (let i = 0; i < resolution.actionable.length; i++) {
				if (aborted) break;

				const task = resolution.actionable[i]!;
				const taskStateIndex = loopState.tasks.findIndex((ts) => ts.id === task.id);
				if (taskStateIndex === -1) continue;
				const taskState = loopState.tasks[taskStateIndex]!;
				loopState.currentTaskIndex = taskStateIndex;
				loopState.currentRetry = 0;
				overlayComponent?.focusTask(taskStateIndex);
				updateStatus();

				taskState.status = "running";
				taskState.startTime = Date.now();
				taskState.endTime = undefined;
				taskState.errors = [];
				taskState.summary = undefined;
				taskState.currentActivity = undefined;
				taskState.currentTurn = 0;
				taskState.outputEvents = [];
				taskState.reviewInfo = undefined;

				/**
				 * Resolving a `needs-human` task: the human's uncommitted changes
				 * replace the implementation phase. "commit" goes straight to the
				 * commit phase, "review" re-enters the review-fix cycle first.
				 */
				const resumeMode = resume && resume.taskId === task.id ? resume.mode : undefined;
				setPhase(taskState, resumeMode === "commit" ? "Commit" : resumeMode === "review" ? "Review" : "Implement");

				/** Cost per phase for the execution report. */
				const phaseCosts: Partial<Record<CostPhase, number>> = {};
				const initialPrompt = buildTaskPrompt(task, prdId);
				let retriesRemaining = settings.implementationRetries;
				let attempt = 1;
				let result: SubagentResult | undefined;
				let currentPrompt = initialPrompt;
				let taskSucceeded = resumeMode !== undefined;
				let taskSkipped = false;

				// Implementation phase (skipped when resolving a needs-human task).
				while (!resumeMode) {
					if (aborted) break;

					const run = await spawnSubagent({
						taskPrompt: currentPrompt,
						model: settings.steps.implement.model,
						thinkingLevel: settings.steps.implement.thinking,
						cwd: ctx.cwd,
						agent,
						signal: currentAbortController.signal,
						onActivity: createActivityHandler(taskState),
					});

					// Parse the raw final text: deterministic repair first, then one
					// LLM repair attempt with the orchestrator model/thinking level.
					const parsedRun = await parseRunResult(run, WORKER_RESULT_SCHEMA, createRepairFactory(taskState));
					result = toWorkerResult(parsedRun);

					addCost(taskState, phaseCosts, "implement", result.usage.cost);
					taskState.summary = result.summary;
					requestOverlayRender();

					if (pauseRequested) {
						pauseRequested = false;
						if (widgetTimer) clearInterval(widgetTimer);
						const pauseAction = await showPauseMenu(ctx, task);

						switch (pauseAction) {
							case "resume":
								currentAbortController = new AbortController();
								currentPrompt = buildContinuePrompt(task, prdId);
								taskState.status = "running";
								taskState.currentActivity = "▶ resuming…";
								widgetTimer = setInterval(requestOverlayRender, 1000);
								requestOverlayRender();
								continue;

							case "release":
								return releaseTask(task, taskState, { reason: "manual pause during implementation" });

							case "retry":
								await discardChanges();
								currentAbortController = new AbortController();
								currentPrompt = initialPrompt;
								retriesRemaining = settings.implementationRetries;
								attempt = 1;
								taskState.retries = 0;
								taskState.errors = [];
								taskState.summary = undefined;
								taskState.status = "running";
								taskState.currentActivity = undefined;
								taskState.currentTurn = 0;
								taskState.outputEvents = [];
								taskState.endTime = undefined;
								loopState.currentRetry = 0;
								widgetTimer = setInterval(requestOverlayRender, 1000);
								requestOverlayRender();
								continue;

							case "skip": {
								await skipTask(task, taskState);
								widgetTimer = setInterval(requestOverlayRender, 1000);
								requestOverlayRender();
								taskSucceeded = false;
								taskSkipped = true;
								break;
							}

							case "abort":
								aborted = true;
								taskState.status = "aborted";
								taskState.summary = "Task execution was cancelled.";
								taskState.endTime = Date.now();
								break;
						}

						if (aborted) break;
						if (taskSkipped) break;
						continue;
					}

					if (aborted) {
						taskState.status = "aborted";
						taskState.summary = "Task execution was cancelled.";
						taskState.endTime = Date.now();
						break;
					}

					if (result.success) {
						taskSucceeded = true;
						taskState.errors = [];
						break;
					}

					taskState.errors = result.errors;
					if (retriesRemaining <= 0) {
						taskState.status = "failed";
						taskState.endTime = Date.now();
						requestOverlayRender();
						return {
							outcome: "failed",
							notification: {
								message: `❌ Task failed: ${task.title} (after ${attempt} attempt${attempt > 1 ? "s" : ""})
Errors: ${result.errors.join("; ")}`,
								level: "error",
							},
						};
					}

					retriesRemaining--;
					attempt++;
					taskState.retries++;
					taskState.status = "retrying";
					loopState.currentRetry = attempt - 1;
					currentPrompt = buildRetryPrompt(task, prdId, result.errors);
					requestOverlayRender();
				}

				if (aborted) {
					if (taskState.status !== "aborted") {
						taskState.status = "aborted";
						taskState.summary = "Task execution was cancelled.";
						taskState.endTime = Date.now();
					}
					break;
				}

				if (!taskSucceeded) continue;

				const implementerSummary = resumeMode
					? "Resolved manually after the task was released to a human (needs-human)."
					: result?.summary ?? "";
				taskState.summary = implementerSummary;

				// --- Review-fix cycle (see ./review-cycle.ts) ---
				let cycle: ReviewCycleState = createReviewCycle({
					fixThreshold: settings.fixThreshold as FindingPriority,
					maxReviewRounds: settings.maxReviewRounds,
				});
				let reviewNote: string | undefined = resumeMode === "commit"
					? "Resolved by a human (needs-human) — changes committed without another automated review."
					: undefined;
				let cycleExit: "commit" | "skipped" | "released" | "aborted" | "failed" = "commit";
				let cycleError = "";
				let releaseRequest: ReleaseRequest | undefined;
				const updateCycleInfo = () => {
					taskState.reviewInfo = formatCycleInfo(cycle);
					requestOverlayRender();
				};

				// "Commit changes & close" skips the review-fix cycle.
				cycleLoop: while (resumeMode !== "commit") {
					if (aborted) {
						cycleExit = "aborted";
						break;
					}
					const step = nextStep(cycle);

					if (step.kind === "commit") break;

					if (step.kind === "review") {
						setPhase(taskState, "Review", `Review ${step.round}/${step.roundLimit}`);
						const reviewOutcome = await runReviewPhase(task, taskState, phaseCosts, {
							round: step.round,
							rejectedFindings: rejectedForNextReview(cycle),
						});
						switch (reviewOutcome.kind) {
							case "reviewed":
								cycle = applyReview(cycle, reviewOutcome.review);
								updateCycleInfo();
								continue cycleLoop;
							case "no-changes":
								reviewNote = step.round === 1
									? "No changes outside .pi/ — review skipped."
									: `No changes outside .pi/ left for review round ${step.round} — review skipped.`;
								if (resumeMode === "review") reviewNote = `Re-reviewed after release to a human (needs-human). ${reviewNote}`;
								if (step.round === 1) taskState.reviewInfo = "skipped (no changes outside .pi/)";
								break cycleLoop;
							case "failed":
								cycleExit = "failed";
								cycleError = reviewOutcome.error;
								break cycleLoop;
							case "released":
								cycleExit = "released";
								releaseRequest = { reason: reviewOutcome.reason, cycle };
								break cycleLoop;
							default:
								cycleExit = reviewOutcome.kind;
								break cycleLoop;
						}
					}

					if (step.kind === "fix") {
						const findingTitle = step.finding.title.replace(/\s+/g, " ").trim();
						setPhase(taskState, "Fix", `Fix ${step.index}/${step.total} [${step.finding.priority}] ${findingTitle}`);
						const fixOutcome = await runFixPhase(task, taskState, phaseCosts, step);
						if (fixOutcome.kind === "result") {
							cycle = applyFixOutcome(cycle, fixOutcome.outcome);
							updateCycleInfo();
							continue;
						}
						cycleExit = fixOutcome.kind;
						if (fixOutcome.kind === "released") {
							releaseRequest = { reason: fixOutcome.reason, cycle, openReason: "Not fixed before the release" };
						}
						break;
					}

					// --- Pause: round limit reached with open findings ---
					taskState.phaseLabel = `Review ${step.round}/${step.roundLimit} — round limit`;
					taskState.currentActivity = `⏸ round limit reached (${step.openFindings.length} open)`;
					requestOverlayRender();
					if (widgetTimer) clearInterval(widgetTimer);
					const roundLimitAction = await showRoundLimitMenu(ctx, task, step);
					widgetTimer = setInterval(requestOverlayRender, 1000);

					switch (roundLimitAction) {
						case "one-more-round":
							cycle = extendRoundLimit(cycle);
							taskState.currentActivity = undefined;
							updateCycleInfo();
							continue;
						case "commit-as-is":
							cycle = commitAsIs(cycle);
							taskState.currentActivity = undefined;
							updateCycleInfo();
							continue;
						case "release":
							cycleExit = "released";
							releaseRequest = {
								reason: `review round limit reached (${step.round}/${step.roundLimit}) with ${step.openFindings.length} open finding${step.openFindings.length === 1 ? "" : "s"}`,
								cycle,
								openReason: `Open at the review round limit (${step.round}/${step.roundLimit})`,
							};
							break cycleLoop;
						case "skip":
							await skipTask(task, taskState, "Skipped at the review round limit.");
							requestOverlayRender();
							cycleExit = "skipped";
							break cycleLoop;
						case "abort":
							aborted = true;
							cycleExit = "aborted";
							break cycleLoop;
					}
				}

				if (cycleExit === "released") {
					return releaseTask(task, taskState, releaseRequest ?? { reason: "released during the review-fix cycle", cycle });
				}
				if (cycleExit === "skipped") continue;
				if (cycleExit === "aborted" || aborted) {
					aborted = true;
					taskState.status = "aborted";
					taskState.summary = "Task execution was cancelled during the review-fix cycle.";
					taskState.endTime = Date.now();
					break;
				}
				if (cycleExit === "failed") {
					taskState.status = "failed";
					taskState.errors = [cycleError];
					taskState.endTime = Date.now();
					requestOverlayRender();
					return {
						outcome: "failed",
						notification: {
							message:
								`❌ Review failed: ${task.title}\n${cycleError}\n` +
								"Uncommitted changes left on disk. Commit or discard them, then re-run /prd-loop-pro.",
							level: "error",
						},
					};
				}

				// --- Commit phase ---
				setPhase(taskState, "Commit");
				const commitOutcome = await runCommitPhase(task, taskState, phaseCosts);

				if (commitOutcome.kind === "released") {
					return releaseTask(task, taskState, { reason: commitOutcome.reason, errors: commitOutcome.errors, cycle });
				}
				if (commitOutcome.kind === "skipped") continue;
				if (commitOutcome.kind === "aborted" || aborted) {
					aborted = true;
					taskState.status = "aborted";
					taskState.summary = "Task execution was cancelled during commit.";
					if (!taskState.endTime) taskState.endTime = Date.now();
					break;
				}

				// Commit SHAs are determined by the orchestrator (HEAD before vs. after).
				const commits = commitOutcome.commits;
				loopState.totalCommits += commits.length;

				// --- Report: append execution report, close todo, update PRD Task Index ---
				if (resumeMode === "review" && reviewNote === undefined) {
					reviewNote = "Re-reviewed after release to a human (needs-human).";
				}
				const record: ExecutionRecord = {
					implementerSummary,
					...reportFields(cycle),
					reviewNote,
					commits,
					cost: phaseCosts,
				};
				const taskBody = await readTodoBody(ctx.cwd, task.id);
				await updateTodoFileBody(ctx.cwd, task.id, appendSection(taskBody, buildExecutionReport(record)));

				taskState.status = "completed";
				taskState.endTime = Date.now();
				taskState.currentActivity = undefined;
				await closeTaskAndUpdateIndex(task, { notifyIndexError: true });

				requestOverlayRender();
			}

			if (aborted) {
				return {
					outcome: "aborted",
					notification: {
						message: "⚠️ Loop aborted. Uncommitted code left on disk.",
						level: "warning",
					},
				};
			}

			// needs-human tasks (and their dependents) keep the PRD open.
			const stillHeld = resolveTaskOrder(tasks).held;
			if (stillHeld.length > 0) {
				return {
					outcome: "completed",
					notification: {
						message:
							`✅ All ${resolution.actionable.length} actionable task(s) executed. ${formatHeldTasks(stillHeld)}`,
						level: "warning",
					},
				};
			}

			if (tasks.every((t) => isTaskClosed(t.status))) {
				await updateTodoFileStatus(ctx.cwd, prdId, "closed");
			}
			return {
				outcome: "completed",
				notification: {
					message: `🎉 PRD Loop Pro complete! All ${resolution.actionable.length} task(s) executed successfully.`,
					level: "info",
				},
			};
		} catch (err) {
			return { outcome: "failed", unexpectedError: err };
		} finally {
			if (widgetTimer) clearInterval(widgetTimer);
			closeOverlay("finished");
		}
	})();

	const [result] = await Promise.all([runPromise, overlayPromise]);

	ctx.ui.setStatus("prd-loop-pro", undefined);

	// Print summary as static text widget
	printSummary(ctx, loopState, prdTitle, result.outcome);

	if (result.notification) ctx.ui.notify(result.notification.message, result.notification.level);
	if (result.unexpectedError) throw result.unexpectedError;
}

// --- Main command handler ---

async function prdLoopHandler(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	// Step 0: Parse arguments (`prd-N` is the only supported argument)
	const parsedArgs = parseCommandArgs(args);
	if (parsedArgs.error) {
		ctx.ui.notify(parsedArgs.error, "error");
		return;
	}

	// Step 1: Git status. Uncommitted changes are only allowed while resolving
	// a needs-human task (checked after the needs-human dialog, see step 2).
	const gitResult = await pi.exec("git", ["status", "--porcelain"]);
	if (gitResult.code !== 0) {
		ctx.ui.notify(`git status failed: ${(gitResult.stderr || gitResult.stdout).trim()}`, "error");
		return;
	}
	const gitStatus = gitResult.stdout;
	const needsHumanTasks = await getNeedsHumanTasks(ctx.cwd, parsedArgs.prdTag);
	if (needsHumanTasks.length === 0) {
		const check = checkGitClean(gitStatus, false);
		if (!check.ok) {
			ctx.ui.notify(check.error, "error");
			return;
		}
	}

	// Step 1b: Commit rules from the package's `/commit` prompt template.
	// Loaded at runtime so editing the template changes the committer's
	// behavior; a missing template is a hard error.
	let commitRules: string;
	try {
		commitRules = await loadCommitRules();
	} catch (err) {
		ctx.ui.notify(`❌ Cannot start PRD Loop Pro: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	// Step 2: needs-human tasks first (before PRD selection):
	// "Commit changes & close" / "Already committed – just close" / "Review again" / "Not now".
	const needsHuman = await offerNeedsHumanTasks(ctx, needsHumanTasks, gitStatus.trim() !== "");
	const resume = needsHuman.resume;

	// Git clean check: uncommitted changes pass only while resolving a needs-human task.
	const gitCheck = checkGitClean(gitStatus, resume !== undefined);
	if (!gitCheck.ok) {
		ctx.ui.notify(gitCheck.error, "error");
		return;
	}

	// Step 3: PRD selection. Resolving a needs-human task selects its PRD; after
	// "just close", the loop continues with the next task of the same PRD.
	let selectedPrd: { prd: TodoItem; openTaskCount: number; totalTaskCount: number } | undefined;

	const activePrds = await getActivePrds(ctx.cwd);

	if (activePrds.length === 0) {
		ctx.ui.notify(
			needsHuman.closedPrdTag ? "No PRDs with open tasks left." : "No PRDs with open tasks found.",
			needsHuman.closedPrdTag ? "info" : "error",
		);
		return;
	}

	const preselectedTag = parsedArgs.prdTag
		?? resume?.entry.prdTag
		?? (needsHuman.closedPrdTag && activePrds.some((p) => p.prd.tags.includes(needsHuman.closedPrdTag!))
			? needsHuman.closedPrdTag
			: null);

	if (preselectedTag) {
		// Direct selection via argument / resolved needs-human task
		selectedPrd = activePrds.find((p) => p.prd.tags.includes(preselectedTag));
		if (!selectedPrd) {
			ctx.ui.notify(`No active PRD found with tag "${preselectedTag}".`, "error");
			return;
		}
	} else {
		// Show selection dialog
		const options = activePrds.map(
			(p) => `${p.prd.title} (${p.openTaskCount}/${p.totalTaskCount} open)`,
		);

		const choice = await ctx.ui.select("Select PRD to work on:", options);
		if (choice === undefined) {
			// User cancelled
			return;
		}

		const choiceIndex = options.indexOf(choice);
		if (choiceIndex === -1) return;
		selectedPrd = activePrds[choiceIndex];
	}

	// Steps 4 + 5: Load/merge/validate settings (wizard on first start) and show the overview.
	// The returned settings are the effective ones (global + project overrides).
	const settings = await resolveStartSettings(ctx, pi, {
		title: selectedPrd.prd.title,
		openTaskCount: selectedPrd.openTaskCount,
		completedTaskCount: selectedPrd.totalTaskCount - selectedPrd.openTaskCount,
	});
	if (!settings) return;

	// Step 6: Run the orchestrator loop (a resolved needs-human task runs first)
	const selectedPrdTag = selectedPrd.prd.tags.find((t) => /^prd-\d+$/.test(t))!;
	await runOrchestratorLoop(ctx, pi, selectedPrd.prd, selectedPrdTag, settings, commitRules, {
		resume: resume ? { taskId: resume.entry.taskId, mode: resume.mode } : undefined,
	});
}

// --- Extension entry point ---

export default function prdLoopProExtension(pi: ExtensionAPI): void {
	const commandConfig = {
		description: "Execute all tasks of a PRD autonomously with subagents",
		handler: (args: string, ctx: ExtensionCommandContext) => prdLoopHandler(args, ctx, pi),
	};

	pi.registerCommand("prd-loop-pro", commandConfig);
	pi.registerCommand("ralph-pro", {
		...commandConfig,
		description: "Alias for /prd-loop-pro — Execute all tasks of a PRD autonomously",
	});
}
