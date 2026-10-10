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
 * 4. Overview menu: entries editable in place; Confirm & start, or with
 *    unsaved changes Save globally & start / Save for this project only & start
 * 5. Orchestrator loop per task: Implement (prd-worker) → Review-fix cycle
 *    (./review-cycle.ts: fresh prd-reviewer per round, one fresh prd-fixer per
 *    round for all findings at/above the fix threshold (checks run once after
 *    all fixes); re-review only if something was fixed; rejected findings +
 *    reasons go into the next review prompt; round limit → pause menu) →
 *    Commit (prd-committer; failure or hook failure pauses the loop, hooks
 *    are never bypassed) → Report
 *    (`## Execution Report` in the task todo incl. rounds, fixed, rejected,
 *    deferred, unresolved findings and created commits, close todo, update
 *    PRD Task Index)
 *
 * Unified pause handling (./pause.ts): the loop never fails hard on a task.
 * Implementation still failing after all retries, an unrepairable JSON result,
 * a crashed reviewer/fixer, a failing committer/hook, the review round limit
 * and a manual Ctrl+C all open a pause menu that shows the task, the current
 * phase and the reason. Ctrl+C offers "Resume current phase", "Skip phase"
 * (not during commit), "Retry task" (discard changes, restart at implement),
 * "Release", "Skip task" and "Abort".
 * Discard operations ("Retry task", "Skip task") never touch `.pi/`
 * (./discard.ts), even when `.pi/` is tracked.
 *
 * "Release (fix manually)" (offered in every pause menu) sets the task todo to
 * `needs-human`, appends the open findings and stops the loop. `needs-human`
 * is not closed: dependent tasks stay blocked until the task is resolved at
 * the next start.
 *
 * UI (view model in ./progress-view.ts): task rows show the current phase and
 * round; task details show the review round counter, fixed/rejected/deferred/
 * unresolved counts and the cost per phase. The output viewer (`o`) groups the
 * events per subagent run under phase headers (`Implement`, `Review #1`,
 * `Fix #1 • 3 findings`, `Commit`) with outcome, cost and duration. The
 * final summary widget lists rounds and counts per task and marks
 * `needs-human` tasks with ⚠️.
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyText, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Key, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
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
	applyFixOutcomes,
	applyReview,
	commitAsIs,
	createReviewCycle,
	cycleCounts,
	extendRoundLimit,
	fixOutcomesFromResult,
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
import { buildPauseMenu, defaultReasonText, releaseReasonFor, skipSummaryFor } from "./pause.ts";
import type { PauseAction, PauseReasonKind, PauseRequest } from "./pause.ts";
import { discardChanges } from "./discard.ts";
import { arrowNavigation, clampScroll, findTaskBlock, revealBlock } from "./overlay-scroll.ts";
import type { RowBlock } from "./overlay-scroll.ts";
import {
	appendOutputEvent,
	appendPhaseEvent,
	buildOutcomeLabel,
	buildSummaryEntryLines,
	buildSummaryTotalsLine,
	buildTaskDetailLines,
	countPhaseEvents,
	finishPhaseGroup,
	formatElapsed,
	fixPhaseLabel,
	formatFixOutcomes,
	formatReviewOutcome,
	phaseGroupMeta,
	startPhaseGroup,
	statusIcon,
} from "./progress-view.ts";
import type {
	OutputEvent,
	PhaseOutputGroup,
	PhaseRef,
	SubagentActivity,
	SummaryEntryLine,
	SummaryInput,
	TaskReviewProgress,
	TaskStatus,
} from "./progress-view.ts";

export { appendOutputEvent };
export type { OutputEvent, SubagentActivity };

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

			// Decode as a UTF-8 stream: multi-byte characters split across chunk
			// boundaries must not turn into U+FFFD (e.g. umlauts in the final JSON).
			proc.stdout.setEncoding("utf8");
			proc.stderr.setEncoding("utf8");

			proc.stdout.on("data", (data: string) => {
				buffer += data;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: string) => {
				stderr += data;
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
		commit: "Commit changes (committer) & close — then continue with the next task",
		close: "Already committed – just close — then continue with the next task",
		review: "Review again — run the review-fix cycle on the current changes, then commit & close",
		"not-now": "Not now — leave the task as needs-human",
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
			const skipAll = "Not now — continue without resolving";
			const options = remaining.map((e) => e.task.title);
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

/** Pipeline phase of a task (shown in the overlay while the task is active). */
type TaskPhase = "Implement" | "Review" | "Fix" | "Commit";

interface LoopTaskState {
	id: string;
	title: string;
	sequenceLabel: string;
	status: TaskStatus;
	/** Current pipeline phase (while running/retrying). */
	phase?: TaskPhase;
	/** Display label of the current phase incl. round progress (e.g. "Review 2/3", "Fix #1 • 3 findings"). */
	phaseLabel?: string;
	/** Review-fix cycle progress (round counter + finding counts), once a review round completed. */
	review?: TaskReviewProgress;
	/** Why the review didn't run / was cut short (e.g. no changes, skipped manually). */
	reviewNote?: string;
	/** Cost per pipeline phase (kept across "Retry task"). */
	phaseCosts: Partial<Record<CostPhase, number>>;
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
	/** Output events for the viewer overlay, grouped per subagent run (phase). */
	outputGroups: PhaseOutputGroup[];
}

interface LoopState {
	startTime: number;
	/** Set once the run is over; freezes the elapsed time in the finished overlay. */
	endTime?: number;
	tasks: LoopTaskState[];
	totalCost: number;
	totalCommits: number;
	currentTaskIndex: number;
	currentRetry: number;
	maxRetries: number;
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

/** Shown by the overlay once the run is over (the overlay stays open until the user closes it). */
interface FinishedOverlayInfo {
	summary: SummaryInput;
	notification?: { message: string; level: "info" | "warning" | "error" };
	error?: string;
}

class PrdLoopOverlayComponent {
	private selectedIndex = 0;
	private expanded = new Set<number>();
	private scrollOffset = 0;
	/** Bring the selected task block into view at the next render (set when the selection/expansion changes). */
	private revealSelected = true;
	/** Layout of the last render, used by ↑/↓ to scroll within the selected block. */
	private lastView: { viewHeight: number; totalRows: number; block: RowBlock } | undefined;

	private confirmingAbort = false;
	private finished: FinishedOverlayInfo | undefined;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private state: LoopState,
		private prdTitle: string,
		private onAbort: () => void,
		private onPause: () => void,
		private onOpenViewer: () => void,
		private requestRender: () => void,
		private onClose: () => void,
	) {
		if (state.tasks.length > 0) this.expanded.add(0);
	}

	/** Switch to the finished view: no pause/abort anymore, Esc/q closes the overlay. */
	markFinished(info: FinishedOverlayInfo): void {
		this.finished = info;
		this.confirmingAbort = false;
		this.requestRender();
	}

	focusTask(index: number): void {
		if (this.state.tasks.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(index, this.state.tasks.length - 1));
		this.expanded.add(this.selectedIndex);
		this.revealSelected = true;
	}

	getSelectedTaskIndex(): number {
		return this.selectedIndex;
	}

	handleInput(data: string): void {
		if (this.finished) {
			if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
				this.onClose();
				return;
			}
			// Nothing left to pause once the run is over.
			if (matchesKey(data, Key.ctrl("c"))) return;
		} else {
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
		}
		if (data === "o" || data === "O") {
			this.onOpenViewer();
			return;
		}

		if (this.state.tasks.length === 0) return;

		if (data === "a" || data === "A") {
			// Toggle all: expand everything unless everything is already expanded.
			if (this.expanded.size === this.state.tasks.length) this.expanded.clear();
			else for (let i = 0; i < this.state.tasks.length; i++) this.expanded.add(i);
			this.revealSelected = true;
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const direction = matchesKey(data, Key.up) ? "up" : "down";
			if (!this.lastView) {
				const step = direction === "up" ? -1 : 1;
				this.selectedIndex = Math.max(0, Math.min(this.state.tasks.length - 1, this.selectedIndex + step));
				this.revealSelected = true;
			} else {
				const result = arrowNavigation(
					direction,
					{ offset: this.scrollOffset, viewHeight: this.lastView.viewHeight, totalRows: this.lastView.totalRows },
					this.lastView.block,
					this.selectedIndex,
					this.state.tasks.length,
				);
				if (result.kind === "none") return;
				if (result.kind === "scroll") {
					this.scrollOffset = result.offset;
				} else {
					this.selectedIndex = result.index;
					this.revealSelected = true;
				}
			}
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 5);
			this.revealSelected = true;
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.selectedIndex = Math.min(this.state.tasks.length - 1, this.selectedIndex + 5);
			this.revealSelected = true;
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, Key.right)) {
			if (this.expanded.has(this.selectedIndex)) this.expanded.delete(this.selectedIndex);
			else this.expanded.add(this.selectedIndex);
			this.revealSelected = true;
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.expanded.delete(this.selectedIndex);
			this.revealSelected = true;
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

		// Selection/expansion changed: show the whole selected task block (header
		// on top if it is taller than the view). Otherwise keep the offset, so
		// ↑/↓ can scroll through blocks line by line.
		const block = findTaskBlock(rows, this.selectedIndex);
		const view = { offset: this.scrollOffset, viewHeight: contentHeight, totalRows: rows.length };
		this.scrollOffset = this.revealSelected
			? revealBlock(view, block)
			: clampScroll(this.scrollOffset, contentHeight, rows.length);
		this.revealSelected = false;
		this.lastView = { viewHeight: contentHeight, totalRows: rows.length, block };

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
		if (this.finished) return this.buildFinishedHeader(width, this.finished);
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

	private buildFinishedHeader(width: number, info: FinishedOverlayInfo): string[] {
		const { summary } = info;
		const outcomeColor = summary.outcome === "completed" ? "success" : summary.outcome === "failed" ? "error" : "warning";
		const lines = [
			truncateToWidth(
				this.theme.fg("accent", this.theme.bold("PRD Loop Pro")) + this.theme.fg("muted", ` • ${this.prdTitle}`),
				width,
			),
			truncateToWidth(this.theme.fg(outcomeColor, this.theme.bold(buildOutcomeLabel(summary.outcome))), width),
		];
		for (const line of wrapTextWithAnsi(this.theme.fg("muted", buildSummaryTotalsLine(summary)), width)) {
			lines.push(truncateToWidth(line, width));
		}
		if (info.notification) {
			const color = info.notification.level === "info" ? "dim" : info.notification.level;
			for (const line of wrapTextWithAnsi(this.theme.fg(color, info.notification.message), width)) {
				lines.push(truncateToWidth(line, width));
			}
		}
		if (info.error) {
			for (const line of wrapTextWithAnsi(this.theme.fg("error", `Unexpected error: ${info.error}`), width)) {
				lines.push(truncateToWidth(line, width));
			}
		}
		lines.push("");
		return lines;
	}

	private buildFooter(width: number, totalRows: number, contentHeight: number): string[] {
		const end = Math.min(totalRows, this.scrollOffset + contentHeight);
		const hint = this.finished
			? this.theme.fg("dim", "↑↓ select/scroll • enter expand • a expand all • o output • esc/q close & post summary to chat")
			: this.confirmingAbort
				? this.theme.fg("warning", "⚠️  Abort loop? Press Esc again to confirm, any other key to cancel")
				: this.theme.fg("dim", "↑↓ select/scroll • enter expand • a expand all • o output • ← collapse • ctrl+c pause • esc abort");
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

			// Round counter, finding counts and cost per phase
			const detailLines = buildTaskDetailLines({
				review: task.review,
				reviewNote: task.reviewNote,
				phaseCosts: task.phaseCosts,
			});
			for (const detail of detailLines) {
				const label = this.theme.fg("dim", `    ${detail.label}: `);
				for (const line of wrapTextWithAnsi(label + this.theme.fg("muted", detail.text), width)) {
					rows.push({ taskIndex: i, kind: "detail", text: truncateToWidth(line, width) });
				}
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

/** Custom session entry type of the final summary (rendered in the chat, never sent to the LLM). */
const SUMMARY_ENTRY_TYPE = "prd-loop-pro-summary";

/**
 * Build the (serializable) final summary of a run. Used for the finished
 * overlay header and stored as custom session entry after the overlay closes.
 */
function buildSummaryInput(state: LoopState, prdTitle: string, outcome: LoopOutcome): SummaryInput {
	return {
		prdTitle,
		outcome,
		tasks: state.tasks.map((task) => ({
			label: `Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`,
			status: task.status,
			elapsedMs: task.endTime && task.startTime ? task.endTime - task.startTime : undefined,
			cost: task.cost,
			retries: task.retries,
			review: task.review ? { ...task.review } : undefined,
			reviewNote: task.review ? undefined : task.reviewNote,
		})),
		totalElapsedMs: (state.endTime ?? Date.now()) - state.startTime,
		totalCost: state.totalCost,
		totalCommits: state.totalCommits,
	};
}

function summaryLineColor(line: SummaryEntryLine): "accent" | "dim" | "error" | "muted" | "success" | "text" | "warning" {
	switch (line.kind) {
		case "totals": return "muted";
		case "hint": return "dim";
		case "task": return line.status ? taskStatusColor(line.status) : "text";
		default: return "text";
	}
}

/** Chat renderer for the summary entry: collapsed shows tasks needing attention, expanded shows all. */
function renderSummaryEntry(summary: SummaryInput, expanded: boolean, theme: Theme): Box {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const outcomeColor = summary.outcome === "completed" ? "success" : summary.outcome === "failed" ? "error" : "warning";
	for (const line of buildSummaryEntryLines(summary, expanded, keyText("app.tools.expand") || "ctrl+o")) {
		if (line.kind === "blank") {
			box.addChild(new Spacer(1));
		} else if (line.kind === "headline") {
			box.addChild(new Text(theme.fg(outcomeColor, theme.bold(line.text)), 0, 0));
		} else {
			box.addChild(new Text(theme.fg(summaryLineColor(line), line.text), 0, 0));
		}
	}
	return box;
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

		const eventCount = countPhaseEvents(task.outputGroups);
		if (this.autoScroll || eventCount !== this.prevEventCount) {
			if (this.autoScroll) {
				this.scrollOffset = Math.max(0, this.totalLines - contentHeight);
			}
			this.prevEventCount = eventCount;
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
		// No caching — always renders fresh from outputGroups
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.85));
	}

	/**
	 * Events grouped by phase: one header per subagent run (`Implement`,
	 * `Review #1`, `Fix #1 • 3 findings`, `Commit`) with outcome, cost and
	 * duration, followed by the run's events.
	 */
	private formatEvents(maxWidth: number): string[] {
		const theme = this.theme;
		const groups = this.taskState.outputGroups;
		if (groups.length === 0) {
			return [theme.fg("muted", "  Waiting for subagent output…")];
		}

		const now = Date.now();
		const lines: string[] = [];
		groups.forEach((group, index) => {
			if (index > 0) lines.push("");
			lines.push(truncateToWidth(this.formatGroupHeader(group, maxWidth, now), maxWidth));
			if (group.events.length === 0) {
				const empty = group.endTime === undefined ? "Waiting for subagent output…" : "(no output)";
				lines.push(truncateToWidth(`  ${theme.fg("muted", empty)}`, maxWidth));
				return;
			}
			for (const ev of group.events) lines.push(...this.formatEvent(ev, maxWidth));
		});
		return lines;
	}

	/** `── Review #1 ─── needs attention • 3 findings • $0.12 • 0:45` */
	private formatGroupHeader(group: PhaseOutputGroup, maxWidth: number, now: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold(group.header));
		const metaText = phaseGroupMeta(group, now);
		const meta = group.failed ? theme.fg("warning", metaText) : theme.fg("muted", metaText);
		const head = `${theme.fg("borderMuted", "──")} ${title} `;
		const tail = ` ${meta}`;
		const fill = Math.max(2, maxWidth - visibleWidth(head) - visibleWidth(tail));
		return head + theme.fg("borderMuted", "─".repeat(Math.min(fill, 6))) + tail;
	}

	private formatEvent(ev: OutputEvent, maxWidth: number): string[] {
		const theme = this.theme;
		const turnLabel = theme.fg("dim", `T${ev.turn}`);
		switch (ev.kind) {
			case "tool_start": {
				const toolName = theme.fg("toolTitle", theme.bold(ev.tool ?? "?"));
				const args = ev.args ? theme.fg("muted", ` ${ev.args}`) : "";
				return [truncateToWidth(`  ${turnLabel} ▶ ${toolName}${args}`, maxWidth)];
			}
			case "tool_end": {
				const icon = ev.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const toolName = ev.error
					? theme.fg("error", ev.tool ?? "?")
					: theme.fg("success", ev.tool ?? "?");
				const lines = [truncateToWidth(`  ${turnLabel} ${icon} ${toolName}`, maxWidth)];
				if (ev.result) {
					for (const pLine of ev.result.split("\n").slice(0, 3)) {
						const sanitized = pLine.replace(/\t/g, " ");
						lines.push(truncateToWidth(`       ${theme.fg("dim", sanitized)}`, maxWidth));
					}
				}
				return lines;
			}
			case "thinking":
				return [truncateToWidth(`  ${turnLabel} ${theme.fg("muted", "🧠 thinking…")}`, maxWidth)];
			case "text":
				return [truncateToWidth(`  ${turnLabel} ${theme.fg("muted", "💬 writing response…")}`, maxWidth)];
		}
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

		const icon = task.status === "running" ? "🔄" : task.status === "retrying" ? "🔁" : statusIcon(task.status);
		const elapsed = task.startTime ? formatElapsed((task.endTime ?? now) - task.startTime) : "0:00";
		const turnInfo = task.currentTurn > 0 ? `T${task.currentTurn}` : "";
		const phaseCount = task.outputGroups.length;
		const eventCount = `${phaseCount} phase${phaseCount === 1 ? "" : "s"} • ${countPhaseEvents(task.outputGroups)} events`;

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

// --- Pause menu (reasons, offered actions and titles: see ./pause.ts) ---

/** Maximum number of open findings listed in the round-limit menu title. */
const ROUND_LIMIT_MAX_LISTED_FINDINGS = 12;

/** One line per open finding: `[P1] file:line — title`. */
export function formatOpenFindingLine(finding: ReviewFinding): string {
	const location = formatLocation(finding) || "(no file)";
	const title = finding.title.replace(/\s+/g, " ").trim() || "(untitled)";
	return `[${finding.priority}] ${location} — ${title}`;
}

/** Detail lines of the round-limit pause: the open findings at/above the fix threshold. */
function roundLimitDetails(step: Extract<CycleStep, { kind: "pause" }>): string[] {
	const count = step.openFindings.length;
	const listed = step.openFindings.slice(0, ROUND_LIMIT_MAX_LISTED_FINDINGS);
	const lines = [
		`${count} open finding${count === 1 ? "" : "s"} at/above the fix threshold:`,
		...listed.map((finding) => `  ${formatOpenFindingLine(finding)}`),
	];
	if (count > listed.length) lines.push(`  … and ${count - listed.length} more`);
	return lines;
}

/**
 * Show a pause menu. The title always states task, phase and reason (plus
 * errors/details); the offered actions depend on reason and phase. Cancelling
 * resumes a manual pause; every other menu is shown again (all of its options
 * have a cost or consequence, so none is chosen implicitly).
 */
async function showPauseMenu(ctx: ExtensionCommandContext, request: PauseRequest): Promise<PauseAction> {
	const menu = buildPauseMenu(request);
	const labels = menu.options.map((option) => option.label);
	while (true) {
		const choice = await ctx.ui.select(menu.title, labels);
		const index = choice === undefined ? -1 : labels.indexOf(choice);
		if (index !== -1) return menu.options[index]!.action;
		if (menu.cancelAction) return menu.cancelAction;
	}
}

/** Review-fix cycle progress (round counter + finding counts) for task details and summary. */
function cycleProgress(cycle: ReviewCycleState): TaskReviewProgress {
	return {
		...cycleCounts(cycle),
		verdict: cycle.rounds.at(-1)?.verdict,
		callouts: cycle.callouts.length,
	};
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
			outputGroups: [],
			phaseCosts: {},
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
	let overlayHandle: OverlayHandle | undefined;
	/** Closes the output viewer overlay (set while it is open). */
	let closeViewer: (() => void) | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;

	const requestOverlayRender = () => {
		if (!overlayClosed && !viewerOpen) overlayRequestRender();
	};
	const closeOverlay = (reason: "finished" | "user-abort") => {
		if (overlayClosed) return;
		overlayClosed = true;
		overlayDone?.(reason);
	};

	/**
	 * Show a dialog (pause menu) while the loop overlay is temporarily hidden.
	 * pi renders select dialogs in the editor area below overlays, so a visible
	 * overlay would cover the dialog and keep looking busy. Hiding it moves the
	 * input focus to the dialog; showing it again restores the focus.
	 */
	const withOverlayHidden = async <T>(dialog: () => Promise<T>): Promise<T> => {
		// The output viewer is an overlay as well; close it so the dialog is visible.
		closeViewer?.();
		const handle = overlayClosed ? undefined : overlayHandle;
		handle?.setHidden(true);
		try {
			return await dialog();
		} finally {
			if (handle && !overlayClosed) handle.setHidden(false);
			requestOverlayRender();
		}
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
					let closed = false;
					const close = () => {
						if (closed) return;
						closed = true;
						clearInterval(refreshTimer);
						closeViewer = undefined;
						done();
					};
					closeViewer = close;
					const viewer = new SubagentOutputViewer(tui, theme, selectedTask, (reason) => {
						if (reason === "pause") {
							pauseRequested = true;
							currentAbortController.abort();
						}
						close();
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
				() => closeOverlay("finished"),
			);
			return overlayComponent;
		},
		{
			overlay: true,
			onHandle: (handle) => {
				overlayHandle = handle;
			},
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

		appendPhaseEvent(taskState.outputGroups, activity);
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
		finishPhaseGroup(taskState.outputGroups, { cost });
		requestOverlayRender();
	};

	/**
	 * Start a new output group for the next subagent run (header in the output
	 * viewer, e.g. `Review #1` or `Fix #1 • 3 findings`).
	 */
	const beginPhaseOutput = (taskState: LoopTaskState, ref: PhaseRef, note?: string) => {
		startPhaseGroup(taskState.outputGroups, ref, { note });
		requestOverlayRender();
	};

	/** Record the one-line outcome of the latest subagent run (output viewer header). */
	const endPhaseOutput = (taskState: LoopTaskState, outcome: string, failed = false) => {
		finishPhaseGroup(taskState.outputGroups, { outcome, failed });
		requestOverlayRender();
	};

	/**
	 * Discard all uncommitted changes outside `.pi/` (see ./discard.ts). Todo
	 * bookkeeping under `.pi/` is never touched, even when `.pi/` is tracked.
	 */
	const discardTaskChanges = () => discardChanges((args) => pi.exec("git", args, { cwd: ctx.cwd }));

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

	/** "Skip task": discard changes (except `.pi/`), close the todo, continue with the next task. */
	const skipTask = async (task: TaskInfo, taskState: LoopTaskState, summary: string) => {
		await discardTaskChanges();
		currentAbortController = new AbortController();
		taskState.status = "completed";
		taskState.endTime = Date.now();
		taskState.currentActivity = undefined;
		taskState.summary = summary;
		taskState.errors = [];
		await closeTaskAndUpdateIndex(task, { notifyIndexError: false });
		requestOverlayRender();
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

	// --- Unified pause handling (see ./pause.ts) ---

	/** Why the loop pauses (reason kind + optional text, errors and detail lines). */
	type PauseOptions = { reason: PauseReasonKind; reasonText?: string; errors?: string[]; details?: string[] };

	/** Exits shared by all phases, chosen in a pause menu. */
	type PhaseExit =
		| { kind: "retry-task" }
		| { kind: "skipped" }
		| { kind: "released"; reason: string; errors?: string[] }
		| { kind: "aborted" };

	/**
	 * Pause the loop and ask the human. The menu shows task, current phase
	 * (incl. round progress) and reason. The overlay refresh stops while the
	 * menu is open; afterwards a fresh abort controller is installed so the
	 * chosen action can spawn subagents again.
	 */
	const pause = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phase: TaskPhase,
		options: PauseOptions,
	): Promise<PauseAction> => {
		pauseRequested = false;
		const reasonText = options.reasonText ?? defaultReasonText(options.reason, phase);
		taskState.currentActivity = `⏸ ${reasonText}`;
		const lastGroup = taskState.outputGroups.at(-1);
		if (lastGroup && lastGroup.outcome === undefined) {
			finishPhaseGroup(taskState.outputGroups, { outcome: `⏸ paused — ${reasonText}`, failed: true });
		}
		requestOverlayRender();
		if (widgetTimer) clearInterval(widgetTimer);
		try {
			return await withOverlayHidden(() =>
				showPauseMenu(ctx, {
					taskLabel: `Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`,
					phase,
					phaseLabel: taskState.phaseLabel ?? phase,
					reason: options.reason,
					reasonText,
					errors: options.errors,
					details: options.details,
				}),
			);
		} finally {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = setInterval(requestOverlayRender, 1000);
			currentAbortController = new AbortController();
			taskState.currentActivity = undefined;
			requestOverlayRender();
		}
	};

	/**
	 * Handle the actions every pause menu shares: "Retry task" (the caller
	 * discards the changes and restarts at implement), "Skip task", "Release"
	 * and "Abort". Phase-specific actions must be handled before; anything
	 * else aborts the loop.
	 */
	const handleCommonPauseAction = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phase: TaskPhase,
		options: PauseOptions,
		action: PauseAction,
	): Promise<PhaseExit> => {
		const reasonInfo = { phase, reason: options.reason, reasonText: options.reasonText };
		switch (action) {
			case "retry-task":
				return { kind: "retry-task" };
			case "skip-task":
				await skipTask(task, taskState, skipSummaryFor(reasonInfo));
				return { kind: "skipped" };
			case "release":
				return { kind: "released", reason: releaseReasonFor(reasonInfo), errors: options.errors };
			default:
				aborted = true;
				return { kind: "aborted" };
		}
	};

	/** ` • JSON repaired` if the result was repaired by the orchestrator model. */
	const repairedSuffix = (parsed: { ok: boolean; repaired?: boolean }) =>
		parsed.ok && parsed.repaired ? " • JSON repaired" : "";

	type ImplementPhaseOutcome =
		| { kind: "implemented"; summary: string }
		| PhaseExit;

	/**
	 * Implement phase: prd-worker subagent (implement model/thinking) with up
	 * to `implementationRetries` automatic retries. Pauses instead of failing:
	 * - still failing after all retries → Retry task / Release / Skip task / Abort
	 * - unrepairable JSON result → Retry phase / Release / Skip task / Abort
	 * - Ctrl+C → Resume / Skip phase / Retry task / Release / Skip task / Abort
	 */
	const runImplementPhase = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phaseCosts: Partial<Record<CostPhase, number>>,
	): Promise<ImplementPhaseOutcome> => {
		let prompt = buildTaskPrompt(task, prdId);
		let retriesRemaining = settings.implementationRetries;
		let attempt = 1;
		/** Qualifier of the next output group header (`resumed`, `retry`). */
		let runNote: string | undefined;

		while (true) {
			if (aborted) return { kind: "aborted" };

			beginPhaseOutput(taskState, { phase: "implement", attempt }, runNote);
			runNote = undefined;
			const run = await spawnSubagent({
				taskPrompt: prompt,
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
			const result = toWorkerResult(parsedRun);
			addCost(taskState, phaseCosts, "implement", result.usage.cost);
			taskState.summary = result.summary;
			requestOverlayRender();

			// --- Pause: Ctrl+C ---
			if (pauseRequested) {
				const options: PauseOptions = { reason: "manual" };
				const action = await pause(task, taskState, "Implement", options);
				if (action === "resume") {
					prompt = buildContinuePrompt(task, prdId);
					runNote = "resumed";
					taskState.currentActivity = "▶ resuming…";
					requestOverlayRender();
					continue;
				}
				if (action === "skip-phase") {
					return {
						kind: "implemented",
						summary: "Implementation phase skipped manually (pause); continued with the changes on disk as-is.",
					};
				}
				return handleCommonPauseAction(task, taskState, "Implement", options, action);
			}

			if (aborted) return { kind: "aborted" };

			// --- Pause: the worker finished, but its result is not valid JSON even after repair ---
			if (!parsedRun.ok && parsedRun.status === "invalid-result") {
				const options: PauseOptions = { reason: "invalid-result", errors: [parsedRun.error] };
				taskState.errors = options.errors!;
				endPhaseOutput(taskState, "invalid JSON result (repair failed)", true);
				const action = await pause(task, taskState, "Implement", options);
				if (action === "retry-phase") {
					prompt = buildContinuePrompt(task, prdId);
					runNote = "retry";
					taskState.errors = [];
					taskState.currentActivity = "▶ retrying implementation…";
					requestOverlayRender();
					continue;
				}
				return handleCommonPauseAction(task, taskState, "Implement", options, action);
			}

			if (result.success) {
				endPhaseOutput(taskState, `success${repairedSuffix(parsedRun)}`);
				taskState.errors = [];
				taskState.status = "running";
				return { kind: "implemented", summary: result.summary };
			}

			taskState.errors = result.errors;
			endPhaseOutput(taskState, `failed — ${result.errors[0] ?? result.summary}`, true);

			// --- Pause: still failing after all retries ---
			if (retriesRemaining <= 0) {
				const options: PauseOptions = {
					reason: "implementation-failed",
					reasonText: `implementation failed after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
					errors: result.errors,
				};
				const action = await pause(task, taskState, "Implement", options);
				return handleCommonPauseAction(task, taskState, "Implement", options, action);
			}

			retriesRemaining--;
			attempt++;
			taskState.retries++;
			taskState.status = "retrying";
			loopState.currentRetry = attempt - 1;
			prompt = buildRetryPrompt(task, prdId, result.errors);
			requestOverlayRender();
		}
	};

	type ReviewPhaseOutcome =
		| { kind: "reviewed"; review: ReviewerResult }
		| { kind: "no-changes" }
		| { kind: "skip-phase" }
		| PhaseExit;

	/**
	 * Review phase: one fresh prd-reviewer subagent (review model/thinking)
	 * reviews the uncommitted changes outside `.pi/` against the task. The
	 * result is parsed and, if needed, repaired with the reviewer schema.
	 * An unrepairable result or a crashed reviewer pauses the loop
	 * (Retry phase / Release / Skip task / Abort).
	 */
	const runReviewPhase = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phaseCosts: Partial<Record<CostPhase, number>>,
		options: { round: number; rejectedFindings: RejectedFinding[] },
	): Promise<ReviewPhaseOutcome> => {
		/** Qualifier of the next output group header (`restarted`, `retry`). */
		let runNote: string | undefined;
		while (true) {
			if (aborted) return { kind: "aborted" };

			let failure: PauseOptions;
			const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all", ...REVIEW_PATHSPEC], { cwd: ctx.cwd });
			if (status.code !== 0) {
				failure = {
					reason: "phase-failed",
					reasonText: "review failed — git status failed",
					errors: [(status.stderr || status.stdout).trim() || `exit code ${status.code}`],
				};
			} else {
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

				beginPhaseOutput(taskState, { phase: "review", round: options.round }, runNote);
				runNote = undefined;
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

				// --- Pause: Ctrl+C ---
				if (pauseRequested) {
					const pauseOptions: PauseOptions = { reason: "manual" };
					const action = await pause(task, taskState, "Review", pauseOptions);
					if (action === "resume") {
						runNote = "restarted";
						taskState.currentActivity = "▶ restarting review…";
						requestOverlayRender();
						continue;
					}
					if (action === "skip-phase") return { kind: "skip-phase" };
					return handleCommonPauseAction(task, taskState, "Review", pauseOptions, action);
				}

				if (aborted) return { kind: "aborted" };
				if (parsed.ok) {
					endPhaseOutput(
						taskState,
						`${formatReviewOutcome(parsed.value.verdict, parsed.value.findings)}${repairedSuffix(parsed)}`,
					);
					return { kind: "reviewed", review: parsed.value };
				}

				endPhaseOutput(
					taskState,
					parsed.status === "invalid-result" ? "invalid JSON result (repair failed)" : `reviewer ${parsed.status}`,
					true,
				);
				failure = parsed.status === "invalid-result"
					? { reason: "invalid-result", errors: [parsed.error] }
					: {
						reason: "phase-failed",
						reasonText: `review failed — the reviewer ${parsed.status === "aborted" ? "was aborted" : "crashed"}`,
						errors: [parsed.error],
					};
			}

			// --- Pause: unrepairable JSON / reviewer failure ---
			taskState.errors = failure.errors ?? [];
			const action = await pause(task, taskState, "Review", failure);
			if (action === "retry-phase") {
				runNote = "retry";
				taskState.errors = [];
				taskState.currentActivity = "▶ retrying review…";
				requestOverlayRender();
				continue;
			}
			return handleCommonPauseAction(task, taskState, "Review", failure, action);
		}
	};

	type FixPhaseOutcome =
		| { kind: "result"; outcomes: FixOutcome[] }
		| PhaseExit;

	/**
	 * Fix phase for all open findings of a review round (batch): one fresh
	 * prd-fixer subagent (fix model/thinking) gets the task title/body and the
	 * numbered findings, fixes the valid ones, rejects the others with a reason
	 * and runs the relevant checks once after all fixes. It returns one outcome
	 * per finding; findings without a result count as unresolved. A crashed
	 * fixer or an unparseable result (even after JSON repair) pauses the loop
	 * (Retry phase / Release / Skip task / Abort), because its partial changes
	 * would otherwise be committed without a re-review. "Skip phase" (Ctrl+C)
	 * leaves all findings of the batch unresolved.
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
			findings: step.findings,
			round: step.round,
			prdId,
		});

		const fixRef: PhaseRef = { phase: "fix", round: step.round, count: step.findings.length };
		/** Qualifier of the next output group header (`restarted`, `retry`). */
		let runNote: string | undefined;
		/** Record the fixer outcomes in the output group and return them. */
		const fixResult = (outcomes: FixOutcome[]): FixPhaseOutcome => {
			endPhaseOutput(taskState, formatFixOutcomes(outcomes), outcomes.some((outcome) => outcome.status === "unresolved"));
			return { kind: "result", outcomes };
		};

		while (true) {
			if (aborted) return { kind: "aborted" };

			beginPhaseOutput(taskState, fixRef, runNote);
			runNote = undefined;
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

			// --- Pause: Ctrl+C ---
			if (pauseRequested) {
				const pauseOptions: PauseOptions = { reason: "manual" };
				const action = await pause(task, taskState, "Fix", pauseOptions);
				if (action === "resume") {
					runNote = "restarted";
					taskState.currentActivity = "▶ restarting fix…";
					requestOverlayRender();
					continue;
				}
				if (action === "skip-phase") {
					return fixResult(step.findings.map(() => ({ status: "unresolved", reason: "Fix skipped manually (pause)" })));
				}
				return handleCommonPauseAction(task, taskState, "Fix", pauseOptions, action);
			}

			if (aborted) return { kind: "aborted" };

			if (parsed.ok) {
				return fixResult(fixOutcomesFromResult(step.findings.length, parsed.value));
			}

			// --- Pause: unrepairable JSON / fixer failure ---
			endPhaseOutput(
				taskState,
				parsed.status === "invalid-result" ? "invalid JSON result (repair failed)" : `fixer ${parsed.status}`,
				true,
			);
			const failure: PauseOptions = parsed.status === "invalid-result"
				? { reason: "invalid-result", errors: [parsed.error] }
				: {
					reason: "phase-failed",
					reasonText: `fix failed — the fixer ${parsed.status === "aborted" ? "was aborted" : "crashed"}`,
					errors: [parsed.error],
				};
			taskState.errors = failure.errors ?? [];
			const action = await pause(task, taskState, "Fix", failure);
			if (action === "retry-phase") {
				runNote = "retry";
				taskState.errors = [];
				taskState.currentActivity = "▶ retrying fix…";
				requestOverlayRender();
				continue;
			}
			return handleCommonPauseAction(task, taskState, "Fix", failure, action);
		}
	};

	type CommitPhaseOutcome =
		| { kind: "committed"; commits: CommitRef[] }
		| PhaseExit;

	/**
	 * Commit phase: a prd-committer subagent (commit model/thinking) commits the
	 * uncommitted changes outside `.pi/` following the `/commit` prompt template
	 * rules. There is no fallback commit: committer failure, a failing hook
	 * (`hookFailed`), an unparseable result, leftover changes or commits touching
	 * `.pi/` pause the loop with "Retry phase" / "Release" / "Skip task" / "Abort".
	 * "Skip phase" is never offered here: uncommitted changes would leak into
	 * the next task.
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
		/** Qualifier of the next output group header (`restarted`, `retry`). */
		let runNote: string | undefined;

		while (true) {
			if (aborted) return { kind: "aborted" };

			let errors: string[] = [];
			let reason: PauseReasonKind = "committer-failed";
			/** True if a committer subagent ran in this iteration (has an output group). */
			let spawned = false;

			const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all", ...REVIEW_PATHSPEC], { cwd: ctx.cwd });
			if (status.code !== 0) {
				errors = [`git status failed: ${(status.stderr || status.stdout).trim()}`];
			} else {
				const changedFiles = filterReviewableStatus(status.stdout);
				if (changedFiles.length > 0) {
					taskState.currentActivity = undefined;
					taskState.currentTurn = 0;
					beginPhaseOutput(taskState, { phase: "commit" }, runNote);
					runNote = undefined;
					spawned = true;
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

					// --- Pause: Ctrl+C (no "Skip phase" during commit) ---
					if (pauseRequested) {
						const pauseOptions: PauseOptions = { reason: "manual" };
						const action = await pause(task, taskState, "Commit", pauseOptions);
						if (action === "resume") {
							runNote = "restarted";
							taskState.currentActivity = "▶ restarting commit…";
							requestOverlayRender();
							continue;
						}
						return handleCommonPauseAction(task, taskState, "Commit", pauseOptions, action);
					}

					if (aborted) return { kind: "aborted" };

					if (!parsed.ok) {
						if (parsed.status === "invalid-result") {
							reason = "invalid-result";
							errors = [`Committer returned no valid result: ${parsed.error}`];
						} else {
							errors = [`Committer ${parsed.status === "aborted" ? "was aborted" : "crashed"}: ${parsed.error}`];
						}
					} else if (parsed.value.hookFailed) {
						reason = "hook-failed";
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
				const commits = await listCommitsSince(pi, ctx.cwd, headBefore);
				if (spawned) endPhaseOutput(taskState, `${commits.length} commit${commits.length === 1 ? "" : "s"} created`);
				return { kind: "committed", commits };
			}

			// --- Pause: committer failed, invalid result or a hook rejected the commit (never bypassed) ---
			const failure: PauseOptions = { reason, errors };
			taskState.errors = errors;
			if (spawned) {
				const what = reason === "hook-failed" ? "hook failed" : reason === "invalid-result" ? "invalid JSON result" : "failed";
				endPhaseOutput(taskState, `${what} — ${errors[0] ?? ""}`, true);
			}
			const action = await pause(task, taskState, "Commit", failure);
			if (action === "retry-phase") {
				runNote = "retry";
				taskState.errors = [];
				taskState.currentActivity = "▶ retrying commit…";
				requestOverlayRender();
				continue;
			}
			return handleCommonPauseAction(task, taskState, "Commit", failure, action);
		}
	};

	/** Outcome of one pipeline run of a task (implement → review-fix → commit → report). */
	type TaskOutcome =
		| { kind: "completed" }
		| { kind: "skipped" }
		| { kind: "retry-task" }
		| { kind: "released"; request: ReleaseRequest }
		| { kind: "aborted"; summary: string };

	/** Map a phase exit to the task outcome (release details from `release`). */
	const exitToTaskOutcome = (
		exit: PhaseExit,
		release: Omit<ReleaseRequest, "reason" | "errors">,
		abortSummary: string,
	): TaskOutcome => {
		switch (exit.kind) {
			case "released":
				return { kind: "released", request: { ...release, reason: exit.reason, errors: exit.errors } };
			case "aborted":
				return { kind: "aborted", summary: abortSummary };
			default:
				return exit;
		}
	};

	/**
	 * Run the pipeline for one task. `resumeMode` (resolving a `needs-human`
	 * task) replaces the implementation phase with the human's uncommitted
	 * changes: "commit" goes straight to the commit phase, "review" re-enters
	 * the review-fix cycle first.
	 */
	const runTaskPipeline = async (
		task: TaskInfo,
		taskState: LoopTaskState,
		phaseCosts: Partial<Record<CostPhase, number>>,
		resumeMode: NeedsHumanResume["mode"] | undefined,
	): Promise<TaskOutcome> => {
		// --- Implement phase (skipped when resolving a needs-human task) ---
		let implementerSummary: string;
		if (resumeMode) {
			implementerSummary = "Resolved manually after the task was released to a human (needs-human).";
		} else {
			setPhase(taskState, "Implement");
			const implement = await runImplementPhase(task, taskState, phaseCosts);
			if (implement.kind !== "implemented") {
				return exitToTaskOutcome(implement, {}, "Task execution was cancelled.");
			}
			implementerSummary = implement.summary;
		}
		taskState.summary = implementerSummary;

		// --- Review-fix cycle (see ./review-cycle.ts) ---
		const cycleAbortSummary = "Task execution was cancelled during the review-fix cycle.";
		let cycle: ReviewCycleState = createReviewCycle({
			fixThreshold: settings.fixThreshold as FindingPriority,
			maxReviewRounds: settings.maxReviewRounds,
		});
		let reviewNote: string | undefined = resumeMode === "commit"
			? "Resolved by a human (needs-human) — changes committed without another automated review."
			: undefined;
		const updateCycleInfo = () => {
			taskState.review = cycleProgress(cycle);
			requestOverlayRender();
		};

		// "Commit changes & close" skips the review-fix cycle.
		cycleLoop: while (resumeMode !== "commit") {
			if (aborted) return { kind: "aborted", summary: cycleAbortSummary };
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
						taskState.reviewNote = reviewNote;
						break cycleLoop;
					case "skip-phase":
						reviewNote = step.round === 1
							? "Review skipped manually (pause) — committed without an automated review."
							: `Review round ${step.round} skipped manually (pause) — the last fixes were committed without a re-review.`;
						taskState.reviewNote = reviewNote;
						break cycleLoop;
					default:
						return exitToTaskOutcome(reviewOutcome, { cycle }, cycleAbortSummary);
				}
			}

			if (step.kind === "fix") {
				setPhase(taskState, "Fix", fixPhaseLabel(step.round, step.findings.length));
				const fixOutcome = await runFixPhase(task, taskState, phaseCosts, step);
				if (fixOutcome.kind === "result") {
					cycle = applyFixOutcomes(cycle, fixOutcome.outcomes);
					updateCycleInfo();
					continue;
				}
				return exitToTaskOutcome(fixOutcome, { cycle, openReason: "Not fixed before the release" }, cycleAbortSummary);
			}

			// --- Pause: round limit reached with open findings ---
			const open = step.openFindings.length;
			taskState.phaseLabel = `Review ${step.round}/${step.roundLimit} — round limit`;
			const limitOptions: PauseOptions = {
				reason: "round-limit",
				reasonText: `review round limit reached (${step.round}/${step.roundLimit}) with ${open} open finding${open === 1 ? "" : "s"}`,
				details: roundLimitDetails(step),
			};
			const roundLimitAction = await pause(task, taskState, "Review", limitOptions);

			switch (roundLimitAction) {
				case "one-more-round":
					cycle = extendRoundLimit(cycle);
					updateCycleInfo();
					continue;
				case "commit-as-is":
					cycle = commitAsIs(cycle);
					updateCycleInfo();
					continue;
				default: {
					const exit = await handleCommonPauseAction(task, taskState, "Review", limitOptions, roundLimitAction);
					return exitToTaskOutcome(
						exit,
						{ cycle, openReason: `Open at the review round limit (${step.round}/${step.roundLimit})` },
						cycleAbortSummary,
					);
				}
			}
		}

		// --- Commit phase ---
		setPhase(taskState, "Commit");
		const commitOutcome = await runCommitPhase(task, taskState, phaseCosts);
		if (commitOutcome.kind !== "committed") {
			return exitToTaskOutcome(commitOutcome, { cycle }, "Task execution was cancelled during commit.");
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
		return { kind: "completed" };
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
				overlayComponent?.focusTask(taskStateIndex);

				/** Resolving a `needs-human` task ("Retry task" restarts it at implement). */
				let resumeMode = resume && resume.taskId === task.id ? resume.mode : undefined;
				/** Cost per phase for the execution report (kept across "Retry task"). */
				const phaseCosts: Partial<Record<CostPhase, number>> = {};
				taskState.phaseCosts = phaseCosts;
				taskState.startTime = Date.now();

				let outcome: TaskOutcome;
				while (true) {
					loopState.currentRetry = 0;
					taskState.status = "running";
					taskState.endTime = undefined;
					taskState.retries = 0;
					taskState.errors = [];
					taskState.summary = undefined;
					taskState.currentActivity = undefined;
					taskState.currentTurn = 0;
					taskState.outputGroups = [];
					taskState.review = undefined;
					taskState.reviewNote = undefined;
					taskState.phase = undefined;
					taskState.phaseLabel = undefined;
					updateStatus();
					requestOverlayRender();

					outcome = await runTaskPipeline(task, taskState, phaseCosts, resumeMode);
					if (outcome.kind !== "retry-task") break;

					// "Retry task": discard changes (except .pi/) and restart at implement.
					await discardTaskChanges();
					resumeMode = undefined;
				}

				if (outcome.kind === "released") {
					return releaseTask(task, taskState, outcome.request);
				}
				if (outcome.kind === "aborted") {
					aborted = true;
					taskState.status = "aborted";
					taskState.summary = outcome.summary;
					if (!taskState.endTime) taskState.endTime = Date.now();
					break;
				}
				// completed / skipped: continue with the next task (unless aborted meanwhile)
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
		}
	})();

	const result = await runPromise;
	loopState.endTime = Date.now();
	ctx.ui.setStatus("prd-loop-pro", undefined);

	const summary = buildSummaryInput(loopState, prdTitle, result.outcome);

	// Keep the overlay open in a finished view so tasks can still be inspected
	// (expand/collapse, output viewer). Closing it posts the summary to the chat.
	// If the user aborted via Esc, the overlay is already closed.
	if (!overlayClosed && overlayComponent) {
		overlayComponent.markFinished({
			summary,
			notification: result.notification,
			error: result.unexpectedError
				? (result.unexpectedError instanceof Error ? result.unexpectedError.message : String(result.unexpectedError))
				: undefined,
		});
		requestOverlayRender();
	} else {
		closeOverlay("finished");
	}
	await overlayPromise;

	// Summary as custom session entry: rendered in the chat (collapsible), never sent to the LLM.
	pi.appendEntry<SummaryInput>(SUMMARY_ENTRY_TYPE, summary);

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

	pi.registerEntryRenderer<SummaryInput>(SUMMARY_ENTRY_TYPE, (entry, { expanded }, theme) =>
		entry.data ? renderSummaryEntry(entry.data, expanded, theme) : undefined,
	);

	pi.registerCommand("prd-loop-pro", commandConfig);
	pi.registerCommand("ralph-pro", {
		...commandConfig,
		description: "Alias for /prd-loop-pro — Execute all tasks of a PRD autonomously",
	});
}
