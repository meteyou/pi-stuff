/**
 * PRD Loop — Autonomous Task Orchestrator with Subagents
 *
 * Commands:
 * - /prd-loop [prd-N] — Execute all tasks of a PRD autonomously
 * - /ralph [prd-N]    — Alias for /prd-loop
 *
 * Start sequence:
 * 1. Git clean check
 * 2. PRD selection (dialog or argument)
 * 3. Configuration dialogs (retry fixes, smart commits, model selection)
 * 4. Confirmation dialog
 * 5. Orchestrator loop: resolve tasks → spawn subagents → commit → update todos
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth, type TUI } from "@mariozechner/pi-tui";

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
 * Check whether a task status represents a completed/closed state.
 * Recognises "closed" (set by the loop) and "done" (set manually or by other tools).
 */
function isTaskClosed(status: string): boolean {
	return status === "closed" || status === "done";
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

// --- Configuration types and flag parsing ---

/** Configuration for the orchestrator loop. */
export interface LoopConfig {
	retryFixes: number;
	smartCommits: boolean;
	model: string; // "provider/model-id" format
	thinkingLevel?: string; // "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
}

/** Parsed flags from the command args string. */
interface ParsedFlags {
	prdTag: string | null;
	retryFixes: number | null;
	smartCommits: boolean | null;
	model: string | null;
	thinkingLevel: string | null;
	error: string | null;
}

/**
 * Parse command args string for the prd-N argument and flags.
 *
 * Format: /prd-loop [prd-N] [--retry-fixes=N] [--smart-commits] [--model=<id>]
 */
export function parseCommandArgs(args: string): ParsedFlags {
	const result: ParsedFlags = {
		prdTag: null,
		retryFixes: null,
		smartCommits: null,
		model: null,
		thinkingLevel: null,
		error: null,
	};

	if (!args.trim()) return result;

	const tokens = args.trim().split(/\s+/);

	for (const token of tokens) {
		if (/^prd-\d+$/i.test(token)) {
			result.prdTag = token.toLowerCase();
		} else if (token.startsWith("--retry-fixes=")) {
			const value = token.slice("--retry-fixes=".length);
			const num = parseInt(value, 10);
			if (isNaN(num) || num < 0) {
				result.error = `Invalid --retry-fixes value: "${value}" (must be a non-negative integer)`;
				return result;
			}
			result.retryFixes = num;
		} else if (token === "--smart-commits") {
			result.smartCommits = true;
		} else if (token.startsWith("--model=")) {
			const value = token.slice("--model=".length);
			if (!value) {
				result.error = `Invalid --model value: empty string`;
				return result;
			}
			result.model = value;
		} else if (token.startsWith("--thinking=")) {
			const value = token.slice("--thinking=".length);
			const validLevels = ["minimal", "low", "medium", "high", "xhigh"];
			if (!validLevels.includes(value)) {
				result.error = `Invalid --thinking value: "${value}" (must be one of: ${validLevels.join(", ")})`;
				return result;
			}
			result.thinkingLevel = value;
		} else if (token.startsWith("--")) {
			result.error = `Unknown flag: "${token}"`;
			return result;
		} else {
			// Ignore other tokens (could be partial PRD names etc.)
		}
	}

	return result;
}

/**
 * Parse the `prd-N` argument from the command args string.
 * @deprecated Use parseCommandArgs() instead — kept for backward compat in tests.
 */
function parsePrdArg(args: string): string | null {
	const parsed = parseCommandArgs(args);
	return parsed.prdTag;
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

export interface SubagentResult {
	success: boolean;
	errors: string[];
	summary: string;
	usage: SubagentUsage;
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
	// Replace newlines with spaces for display
	const clean = s.replace(/\n/g, " ").trim();
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
 * Load the prd-worker agent definition from the extension's agents/ directory.
 */
async function loadPrdWorkerAgent(extensionDir: string): Promise<AgentDefinition> {
	const agentPath = join(extensionDir, "agents", "prd-worker.md");
	const content = await readFile(agentPath, "utf-8");
	const agent = loadAgentDefinition(agentPath, content);
	if (!agent) {
		throw new Error(`Failed to parse prd-worker agent at ${agentPath}`);
	}
	return agent;
}

/**
 * Parse the structured JSON result from the subagent's final output.
 *
 * Tries to find a JSON object with `success`, `errors`, and `summary` fields
 * in the text. Handles both raw JSON and JSON in markdown code fences.
 */
function parseSubagentResult(text: string): { success: boolean; errors: string[]; summary: string } | null {
	if (!text.trim()) return null;

	// Try parsing the entire text as JSON first
	try {
		const parsed = JSON.parse(text.trim());
		if (typeof parsed.success === "boolean") {
			return {
				success: parsed.success,
				errors: Array.isArray(parsed.errors) ? parsed.errors : [],
				summary: typeof parsed.summary === "string" ? parsed.summary : "",
			};
		}
	} catch {
		// Not valid JSON as a whole, try extracting
	}

	// Try to find JSON in the last part of the text (subagent should output it last)
	// Look for the last JSON object that contains "success"
	const jsonPattern = /\{[^{}]*"success"\s*:\s*(true|false)[^{}]*\}/g;
	let lastMatch: string | null = null;
	let match: RegExpExecArray | null;
	while ((match = jsonPattern.exec(text)) !== null) {
		lastMatch = match[0];
	}

	if (lastMatch) {
		try {
			const parsed = JSON.parse(lastMatch);
			return {
				success: Boolean(parsed.success),
				errors: Array.isArray(parsed.errors) ? parsed.errors : [],
				summary: typeof parsed.summary === "string" ? parsed.summary : "",
			};
		} catch {
			// Matched pattern but not valid JSON
		}
	}

	// Try extracting from markdown code fences
	const fencePattern = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
	let lastFenceMatch: string | null = null;
	while ((match = fencePattern.exec(text)) !== null) {
		lastFenceMatch = match[1];
	}

	if (lastFenceMatch) {
		try {
			const parsed = JSON.parse(lastFenceMatch);
			if (typeof parsed.success === "boolean") {
				return {
					success: parsed.success,
					errors: Array.isArray(parsed.errors) ? parsed.errors : [],
					summary: typeof parsed.summary === "string" ? parsed.summary : "",
				};
			}
		} catch {
			// Not valid JSON in fence
		}
	}

	return null;
}

/**
 * Get the final assistant text output from the message stream.
 */
function getFinalAssistantText(messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) return part.text;
			}
		}
	}
	return "";
}

const SIGKILL_TIMEOUT_MS = 5000;

/**
 * Spawn a pi subagent process to execute a task.
 *
 * The subagent runs in an isolated context window with the prd-worker agent definition
 * as its system prompt. It returns a structured JSON result.
 *
 * @param options.taskPrompt - The full prompt to send to the subagent (task body + context)
 * @param options.model - Model to use (overrides agent default)
 * @param options.cwd - Working directory for the subagent process
 * @param options.agent - The agent definition (loaded from prd-worker.md)
 * @param options.signal - AbortSignal for cancellation
 * @returns SubagentResult with success/failure, errors, summary, and usage stats
 */
export async function spawnSubagent(options: {
	taskPrompt: string;
	model?: string;
	thinkingLevel?: string;
	cwd: string;
	agent: AgentDefinition;
	signal?: AbortSignal;
	onActivity?: (activity: SubagentActivity) => void;
}): Promise<SubagentResult> {
	const { taskPrompt, model, thinkingLevel, cwd, agent, signal, onActivity } = options;

	// Write agent system prompt to temp file
	const tmpDir = mkdtempSync(join(tmpdir(), "prd-loop-"));
	const promptPath = join(tmpDir, "prd-worker-prompt.md");
	writeFileSync(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });

	// Build pi arguments
	const args: string[] = ["--mode", "json", "-p", "--no-session"];

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
	let stderr = "";
	let wasAborted = false;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;

				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Track message_end events for usage stats and message content
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

				// Also track tool_result_end for the full message history
				if (event.type === "tool_result_end" && event.message) {
					messages.push(event.message);
				}

				// Stream activity events to the caller
				if (onActivity) {
					if (event.type === "tool_execution_start") {
						onActivity({
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
						onActivity({
							type: "tool_end",
							toolName: event.toolName,
							toolSuccess: !event.isError,
							resultPreview,
							turn: usage.turns + 1,
						});
					} else if (event.type === "message_update" && event.assistantMessageEvent) {
						const ame = event.assistantMessageEvent;
						if (ame.type === "text_delta" && ame.delta) {
							onActivity({
								type: "text_delta",
								text: ame.delta,
								turn: usage.turns + 1,
							});
						} else if (ame.type === "thinking_delta" || ame.type === "thinking") {
							onActivity({
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
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
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
					signal.addEventListener("abort", killProc, { once: true });
				}
			}
		});

		// Handle abort
		if (wasAborted) {
			return {
				success: false,
				errors: ["Subagent was aborted"],
				summary: "Task execution was cancelled",
				usage,
			};
		}

		// Handle non-zero exit code
		if (exitCode !== 0) {
			return {
				success: false,
				errors: [`Subagent exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`],
				summary: "Subagent process failed",
				usage,
			};
		}

		// Extract and parse the structured JSON result from the final assistant message
		const finalText = getFinalAssistantText(messages);
		const parsed = parseSubagentResult(finalText);

		if (!parsed) {
			return {
				success: false,
				errors: ["Failed to parse result: subagent did not return valid JSON"],
				summary: finalText ? finalText.slice(0, 200) : "No output from subagent",
				usage,
			};
		}

		return {
			success: parsed.success,
			errors: parsed.errors,
			summary: parsed.summary,
			usage,
		};
	} finally {
		// Clean up temp files
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

// --- Task resolution and dependency graph ---

export interface TaskInfo {
	id: string;
	title: string;
	status: string;
	body: string;
	blockedBy: string[];
	sequenceLabel: string; // e.g. "1/8"
}

/**
 * Parse the "Blocked by" section from a task body to extract blocker TODO-IDs.
 *
 * Handles:
 * - "None — can start immediately" → []
 * - "- TODO-abc123 (PRD #1 - Task 1/8: ...)" → ["TODO-abc123"]
 * - Multiple "- TODO-xxx" lines → ["TODO-xxx", ...]
 */
export function parseBlockedBy(body: string): string[] {
	const blockers: string[] = [];

	// Find the "## Blocked by" section
	const sectionMatch = body.match(/##\s*Blocked by\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/i);
	if (!sectionMatch) return blockers;

	const section = sectionMatch[1];

	// Check for "None" indicator
	if (/none/i.test(section) && /can start/i.test(section)) {
		return blockers;
	}

	// Extract TODO-IDs from list items
	const todoIdPattern = /TODO-([0-9a-f]+)/gi;
	let match: RegExpExecArray | null;
	while ((match = todoIdPattern.exec(section)) !== null) {
		blockers.push(`TODO-${match[1]}`);
	}

	return blockers;
}

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

export interface TaskResolutionResult {
	/** Ordered list of open, actionable tasks to execute */
	actionable: TaskInfo[];
	/** All tasks (including closed and blocked) */
	allTasks: TaskInfo[];
	/** Error message if circular dependency detected */
	error?: string;
}

/**
 * Resolve task dependencies and produce an ordered execution list.
 *
 * Uses Kahn's algorithm (BFS topological sort):
 * 1. Build adjacency list and in-degree count from dependency relationships
 * 2. Start with tasks that have no unresolved dependencies
 * 3. Process tasks in topological order
 * 4. Skip closed tasks (they're already done)
 * 5. Detect circular dependencies
 *
 * A dependency is "resolved" if the blocker task is closed.
 */
export function resolveTaskOrder(tasks: TaskInfo[]): TaskResolutionResult {
	const taskMap = new Map<string, TaskInfo>();
	for (const task of tasks) {
		taskMap.set(task.id, task);
	}

	// Filter to open tasks only
	const openTasks = tasks.filter((t) => !isTaskClosed(t.status));

	if (openTasks.length === 0) {
		return { actionable: [], allTasks: tasks };
	}

	// Build in-degree count for open tasks only
	// A dependency counts toward in-degree ONLY if the blocker is also open
	// (closed blockers are already satisfied)
	const inDegree = new Map<string, number>();
	const dependents = new Map<string, string[]>(); // blocker → [tasks that depend on it]

	for (const task of openTasks) {
		inDegree.set(task.id, 0);
	}

	for (const task of openTasks) {
		for (const blockerId of task.blockedBy) {
			const blocker = taskMap.get(blockerId);

			// If blocker doesn't exist in this PRD or is closed, it's resolved
			if (!blocker || isTaskClosed(blocker.status)) {
				continue;
			}

			// Blocker is open → this creates a real dependency
			inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);

			if (!dependents.has(blockerId)) {
				dependents.set(blockerId, []);
			}
			dependents.get(blockerId)!.push(task.id);
		}
	}

	// Kahn's algorithm
	const queue: string[] = [];
	for (const task of openTasks) {
		if ((inDegree.get(task.id) || 0) === 0) {
			queue.push(task.id);
		}
	}

	const sorted: TaskInfo[] = [];
	let processed = 0;

	while (queue.length > 0) {
		const taskId = queue.shift()!;
		const task = taskMap.get(taskId)!;
		sorted.push(task);
		processed++;

		const deps = dependents.get(taskId) || [];
		for (const depId of deps) {
			const newDegree = (inDegree.get(depId) || 1) - 1;
			inDegree.set(depId, newDegree);
			if (newDegree === 0) {
				queue.push(depId);
			}
		}
	}

	// Circular dependency detection
	if (processed < openTasks.length) {
		const stuck = openTasks
			.filter((t) => !sorted.some((s) => s.id === t.id))
			.map((t) => t.title)
			.join(", ");
		return {
			actionable: [],
			allTasks: tasks,
			error: `Circular dependency detected among tasks: ${stuck}`,
		};
	}

	return { actionable: sorted, allTasks: tasks };
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

// --- PRD Task Index update ---

/**
 * Update the PRD Task Index body after a task is completed.
 *
 * - Marks the completed task as ✅ closed
 * - Updates blocked tasks to 🔄 open if all their blockers are now closed
 * - Updates the "Start with" pointer to the next actionable task
 */
function updateTaskIndexBody(
	body: string,
	completedTaskId: string,
	allTasks: TaskInfo[],
): string {
	// Build the set of all closed task IDs (including the just-completed one)
	const closedIds = new Set<string>();
	for (const t of allTasks) {
		if (isTaskClosed(t.status)) closedIds.add(t.id);
	}
	closedIds.add(completedTaskId);

	const lines = body.split("\n");
	const updatedLines: string[] = [];

	for (const line of lines) {
		// Match Task Index table rows: contain a TODO-xxx reference and a status indicator
		const todoMatch = line.match(/TODO-[0-9a-f]+/i);
		const isTableRow = line.includes("|") && todoMatch &&
			(line.includes("✅") || line.includes("🔄") || line.includes("⏳") || line.includes("❌"));

		if (isTableRow && todoMatch) {
			const taskId = todoMatch[0];

			if (closedIds.has(taskId)) {
				// Mark as closed
				updatedLines.push(
					line.replace(/🔄 open|⏳ blocked|❌ failed/, "✅ closed"),
				);
			} else {
				// Check if this task's blockers are all resolved
				const task = allTasks.find((t) => t.id === taskId);
				if (task && task.blockedBy.every((b) => closedIds.has(b))) {
					updatedLines.push(line.replace(/⏳ blocked/, "🔄 open"));
				} else {
					updatedLines.push(line);
				}
			}
		} else if (line.startsWith("Start with:")) {
			// Find the next actionable open task (not closed, all blockers resolved)
			const nextTask = allTasks
				.filter((t) => !closedIds.has(t.id))
				.find((t) => t.blockedBy.every((b) => closedIds.has(b)));

			if (nextTask) {
				updatedLines.push(`Start with: **${nextTask.id}** (${nextTask.title})`);
			} else {
				updatedLines.push("Start with: All tasks completed! 🎉");
			}
		} else {
			updatedLines.push(line);
		}
	}

	return updatedLines.join("\n");
}

/**
 * Sync the PRD Task Index body with the actual todo file statuses.
 *
 * Called once at loop start so that tasks completed outside the loop
 * (e.g. via `/todos`) are reflected in the PRD table before execution begins.
 *
 * For each table row referencing a TODO-xxx:
 * - Closed/done tasks  → "✅ done"
 * - Open, all blockers resolved → "🔓 ready"
 * - Open, unresolved blockers   → "⏳ blocked"
 *
 * Also updates the "Next up:" / "Start with:" pointer.
 */
function syncPrdTaskIndex(body: string, allTasks: TaskInfo[]): string {
	const taskMap = new Map<string, TaskInfo>();
	for (const t of allTasks) {
		taskMap.set(t.id, t);
	}

	const closedIds = new Set<string>();
	for (const t of allTasks) {
		if (isTaskClosed(t.status)) closedIds.add(t.id);
	}

	const lines = body.split("\n");
	const updatedLines: string[] = [];

	for (const line of lines) {
		const todoMatch = line.match(/TODO-[0-9a-f]+/i);
		// Table data rows have multiple pipes and a TODO reference
		const pipeCount = (line.match(/\|/g) || []).length;
		const isTableRow = pipeCount >= 4 && todoMatch;

		if (isTableRow && todoMatch) {
			const taskId = todoMatch[0];
			const task = taskMap.get(taskId);

			if (!task) {
				updatedLines.push(line);
				continue;
			}

			// Replace the last meaningful cell (Status column)
			const cells = line.split("|");
			const statusCellIndex = cells.length - 2; // last cell before trailing ""

			if (statusCellIndex < 1) {
				updatedLines.push(line);
				continue;
			}

			let newStatus: string;
			if (isTaskClosed(task.status)) {
				newStatus = " ✅ done ";
			} else if (task.blockedBy.every((b) => closedIds.has(b))) {
				newStatus = " 🔓 ready ";
			} else {
				newStatus = " ⏳ blocked ";
			}

			cells[statusCellIndex] = newStatus;
			updatedLines.push(cells.join("|"));
		} else if (/^(Next up|Start with)\s*:/i.test(line)) {
			// Update the pointer to the next actionable task
			const nextTask = allTasks
				.filter((t) => !isTaskClosed(t.status))
				.find((t) => t.blockedBy.every((b) => closedIds.has(b)));

			if (nextTask) {
				updatedLines.push(`Next up: **${nextTask.id}** (${nextTask.title})`);
			} else if (allTasks.every((t) => isTaskClosed(t.status))) {
				updatedLines.push(`Next up: All tasks completed! 🎉`);
			} else {
				updatedLines.push(line);
			}
		} else {
			updatedLines.push(line);
		}
	}

	return updatedLines.join("\n");
}

// --- Orchestrator loop ---

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
 * Extract the short title from a task title (removes "PRD #N - Task M/T: " prefix).
 */
function extractShortTitle(title: string): string {
	const match = title.match(/Task\s+\d+\/\d+:\s*(.*)/i);
	return match ? match[1].trim() : title;
}

// --- Loop state and widget ---

type TaskStatus = "pending" | "running" | "completed" | "failed" | "retrying" | "aborted";

interface LoopTaskState {
	id: string;
	title: string;
	sequenceLabel: string;
	status: TaskStatus;
	startTime?: number;
	endTime?: number;
	cost: number;
	retries: number;
	errors: string[];
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
	}
}

/**
 * Build the live progress widget lines.
 */
function buildProgressWidget(state: LoopState, prdTitle: string): string[] {
	const now = Date.now();
	const lines: string[] = [];

	lines.push(`┌─ ${prdTitle} ${"─".repeat(Math.max(0, 50 - prdTitle.length))}┐`);

	for (const task of state.tasks) {
		const icon = statusIcon(task.status);
		const label = `Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`;

		let timePart = "";
		if (task.status === "running" || task.status === "retrying") {
			timePart = task.startTime ? ` (${formatElapsed(now - task.startTime)})` : "";
		} else if (task.endTime && task.startTime) {
			timePart = ` (${formatElapsed(task.endTime - task.startTime)})`;
		}

		let retryPart = "";
		if (task.status === "retrying") {
			retryPart = ` [attempt ${state.currentRetry + 1}/${state.maxRetries + 1}]`;
		}

		lines.push(`│ ${icon} ${label}${timePart}${retryPart}`);

		// Show current subagent activity for running tasks
		if ((task.status === "running" || task.status === "retrying") && task.currentActivity) {
			const turnInfo = task.currentTurn > 0 ? `T${task.currentTurn}` : "";
			lines.push(`│   └─ ${turnInfo} ${task.currentActivity}`);
		}
	}

	lines.push("│");

	const currentTask = state.tasks[state.currentTaskIndex];
	const retryStr = currentTask
		? `Retry: ${currentTask.retries}/${state.maxRetries}`
		: `Retry: 0/${state.maxRetries}`;
	const costStr = `Cost: $${state.totalCost.toFixed(2)}`;
	const elapsedStr = `Elapsed: ${formatElapsed(now - state.startTime)}`;

	lines.push(`│ ${retryStr} | ${costStr} | ${elapsedStr}`);
	lines.push(`│ Enter: view output | Ctrl+C: pause`);
	lines.push(`└${"─".repeat(54)}┘`);

	return lines;
}

/**
 * Build the final summary widget lines.
 */
function buildSummaryWidget(
	state: LoopState,
	prdTitle: string,
	outcome: "completed" | "failed" | "aborted",
): string[] {
	const lines: string[] = [];

	const outcomeIcon = outcome === "completed" ? "✅" : outcome === "failed" ? "❌" : "⚠️";
	const outcomeText = outcome === "completed" ? "Loop completed" : outcome === "failed" ? "Loop failed" : "Loop aborted";
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

	return lines;
}

// --- Pause menu ---

type PauseAction = "release" | "retry" | "skip" | "abort";

/**
 * Show an interactive pause menu after Ctrl+C interrupts a running subagent.
 *
 * Options:
 * - Release session: exit the loop, keep changes on disk for manual fixing
 * - Retry task: discard uncommitted changes, retry from scratch
 * - Skip task: discard uncommitted changes, mark as done, continue
 * - Abort loop: stop everything, keep changes on disk
 */
async function showPauseMenu(ctx: ExtensionCommandContext, task: TaskInfo): Promise<PauseAction> {
	const options = [
		"🔧 Release session — fix manually, re-run /prd-loop to continue",
		"🔄 Retry task — discard changes, try again from scratch",
		"⏭️  Skip task — discard changes, mark done, continue with next",
		"❌ Abort loop — stop and keep changes on disk",
	];

	const choice = await ctx.ui.select(
		`⏸️  Paused — Task ${task.sequenceLabel}: ${extractShortTitle(task.title)}`,
		options,
	);

	switch (choice) {
		case options[0]: return "release";
		case options[1]: return "retry";
		case options[2]: return "skip";
		case options[3]: return "abort";
		default: return "release"; // User cancelled select → treat as release
	}
}

// --- Smart commits (prd-committer agent) ---

/**
 * Load the prd-committer agent definition from the extension's agents/ directory.
 */
async function loadPrdCommitterAgent(extensionDir: string): Promise<AgentDefinition> {
	const agentPath = join(extensionDir, "agents", "prd-committer.md");
	const content = await readFile(agentPath, "utf-8");
	const agent = loadAgentDefinition(agentPath, content);
	if (!agent) {
		throw new Error(`Failed to parse prd-committer agent at ${agentPath}`);
	}
	return agent;
}

/**
 * Spawn a committer subagent that creates granular conventional commits.
 * Returns the number of commits created, or -1 on failure.
 */
async function spawnCommitterSubagent(
	cwd: string,
	prdTag: string,
	model: string,
	thinkingLevel?: string,
	signal?: AbortSignal,
): Promise<{ success: boolean; commitCount: number; cost: number }> {
	try {
		const agent = await loadPrdCommitterAgent(EXTENSION_DIR);
		const prompt = [
			`Analyze all uncommitted changes and create granular conventional commits.`,
			``,
			`The PRD scope is: ${prdTag}`,
			`Use "${prdTag}" as the scope in all commit messages (e.g., feat(${prdTag}): ...).`,
		].join("\n");

		const result = await spawnSubagent({
			taskPrompt: prompt,
			model,
			thinkingLevel,
			cwd,
			agent,
			signal,
		});

		if (result.success) {
			// Try to extract commitCount from the summary or result
			const commitCountMatch = result.summary.match(/(\d+)\s*commit/i);
			const commitCount = commitCountMatch ? parseInt(commitCountMatch[1], 10) : 1;
			return { success: true, commitCount, cost: result.usage.cost };
		}

		return { success: false, commitCount: 0, cost: result.usage.cost };
	} catch {
		return { success: false, commitCount: 0, cost: 0 };
	}
}

/**
 * Simple auto-commit: stages all changes and creates a single conventional commit.
 */
async function simpleAutoCommit(
	pi: ExtensionAPI,
	cwd: string,
	prdTag: string,
	sequenceLabel: string,
	shortTitle: string,
): Promise<{ committed: boolean; error?: string }> {
	const commitMsg = `feat(${prdTag}): task ${sequenceLabel} - ${shortTitle}`;

	await pi.exec("git", ["add", "-A"], { cwd });
	const commitResult = await pi.exec("git", ["commit", "-m", commitMsg], { cwd });

	if (commitResult.code !== 0) {
		if (commitResult.stdout.includes("nothing to commit")) {
			return { committed: false };
		}
		return { committed: false, error: commitResult.stderr || commitResult.stdout };
	}
	return { committed: true };
}

// --- Orchestrator loop ---

/**
 * Run the orchestrator loop: resolve tasks, spawn subagents, commit, update todos.
 *
 * Features:
 * - Live progress widget via ctx.ui.setWidget()
 * - AbortController for Ctrl+C handling
 * - Periodic timer for elapsed time updates
 * - Smart commits via prd-committer subagent
 * - Final summary widget on completion/failure/abort
 */
async function runOrchestratorLoop(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	prd: TodoItem,
	prdTag: string,
	config: LoopConfig,
): Promise<void> {
	// Load the prd-worker agent definition
	const agent = await loadPrdWorkerAgent(EXTENSION_DIR);

	// Normalize PRD id to include TODO- prefix
	const prdId = prd.id.startsWith("TODO-") ? prd.id : `TODO-${prd.id}`;

	// Fetch and resolve tasks
	const tasks = await fetchPrdTasks(ctx.cwd, prdTag);
	const resolution = resolveTaskOrder(tasks);

	// Sync PRD Task Index with actual todo statuses (picks up tasks closed outside the loop)
	try {
		const currentPrdBody = await readTodoBody(ctx.cwd, prdId);
		const syncedBody = syncPrdTaskIndex(currentPrdBody, tasks);
		if (syncedBody !== currentPrdBody) {
			await updateTodoFileBody(ctx.cwd, prdId, syncedBody);
		}
	} catch (err) {
		ctx.ui.notify(
			`⚠️ Failed to sync PRD Task Index: ${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
	}

	// Handle circular dependency
	if (resolution.error) {
		ctx.ui.notify(resolution.error, "error");
		return;
	}

	// Handle no open tasks
	if (resolution.actionable.length === 0) {
		ctx.ui.notify("All tasks already completed.", "info");
		if (!isTaskClosed(prd.status)) {
			await updateTodoFileStatus(ctx.cwd, prdId, "closed");
		}
		return;
	}

	// --- Initialize loop state ---
	// Show ALL tasks in the widget (sorted by sequence label), pre-marking completed ones
	const allTasksSorted = [...resolution.allTasks].sort((a, b) => {
		const aNum = parseFloat(a.sequenceLabel.split("/")[0]) || 999;
		const bNum = parseFloat(b.sequenceLabel.split("/")[0]) || 999;
		if (aNum !== bNum) return aNum - bNum;
		return a.title.localeCompare(b.title);
	});

	const loopState: LoopState = {
		startTime: Date.now(),
		tasks: allTasksSorted.map((t) => ({
			id: t.id,
			title: t.title,
			sequenceLabel: t.sequenceLabel,
			status: isTaskClosed(t.status) ? "completed" as TaskStatus : "pending" as TaskStatus,
			cost: 0,
			retries: 0,
			errors: [],
		})),
		totalCost: 0,
		totalCommits: 0,
		currentTaskIndex: 0,
		currentRetry: 0,
		maxRetries: config.retryFixes,
	};

	const prdTitle = prd.title;

	// --- Set up live widget ---
	const updateWidget = () => {
		ctx.ui.setWidget("prd-loop", buildProgressWidget(loopState, prdTitle));
	};

	updateWidget();

	// Periodic timer to update elapsed time display (mutable: paused/restarted on Ctrl+C menu)
	let widgetTimer = setInterval(updateWidget, 1000);

	// --- Set up abort controller for Ctrl+C (pause & menu) ---
	let currentAbortController = new AbortController();
	let aborted = false;
	let pauseRequested = false;

	const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
		// Ctrl+C is sent as \x03 — pause the loop and show menu
		if (data === "\x03") {
			pauseRequested = true;
			currentAbortController.abort();
			return { consume: true };
		}
		return undefined;
	});

	// --- Helper to show summary and clean up ---
	const cleanup = (outcome: "completed" | "failed" | "aborted") => {
		clearInterval(widgetTimer);
		unsubscribeInput();
		ctx.ui.setWidget("prd-loop", buildSummaryWidget(loopState, prdTitle, outcome));
	};

	try {
		for (let i = 0; i < resolution.actionable.length; i++) {
			if (aborted) break;

			const task = resolution.actionable[i];
			const taskStateIndex = loopState.tasks.findIndex((ts) => ts.id === task.id);
			const taskState = loopState.tasks[taskStateIndex];
			loopState.currentTaskIndex = taskStateIndex;
			loopState.currentRetry = 0;

			// Mark task as running
			taskState.status = "running";
			taskState.startTime = Date.now();
			updateWidget();

			// Build the initial subagent prompt
			const initialPrompt = buildTaskPrompt(task, prdId);

			// Retry loop: 1 initial attempt + config.retryFixes retries
			let retriesRemaining = config.retryFixes;
			let attempt = 1;
			let result: SubagentResult;
			let currentPrompt = initialPrompt;
			let taskSucceeded = false;

			// eslint-disable-next-line no-constant-condition
			while (true) {
				if (aborted) break;

				// Spawn the subagent
				result = await spawnSubagent({
					taskPrompt: currentPrompt,
					model: config.model,
					thinkingLevel: config.thinkingLevel,
					cwd: ctx.cwd,
					agent,
					signal: currentAbortController.signal,
				});

				// Accumulate cost
				taskState.cost += result.usage.cost;
				loopState.totalCost += result.usage.cost;

				// Check if pause was requested (Ctrl+C)
				if (pauseRequested) {
					pauseRequested = false;
					clearInterval(widgetTimer); // Pause widget updates during menu
					const pauseAction = await showPauseMenu(ctx, task);

					switch (pauseAction) {
						case "release":
							// Exit loop, keep changes on disk for manual fixing
							cleanup("aborted");
							ctx.ui.notify(
								"⏸️ Session released. Uncommitted changes left on disk.\n" +
								"Fix issues and re-run /prd-loop to continue from where you left off.",
								"info",
							);
							return;

						case "retry":
							// Discard uncommitted changes and retry task from scratch
							await pi.exec("git", ["checkout", "."], { cwd: ctx.cwd });
							await pi.exec("git", ["clean", "-fd"], { cwd: ctx.cwd });
							currentAbortController = new AbortController();
							currentPrompt = initialPrompt;
							retriesRemaining = config.retryFixes;
							attempt = 1;
							taskState.retries = 0;
							taskState.status = "running";
							loopState.currentRetry = 0;
							// Restart widget timer
							widgetTimer = setInterval(updateWidget, 1000);
							updateWidget();
							continue; // Restart while loop

						case "skip": {
							// Discard uncommitted changes, mark task as done, continue
							await pi.exec("git", ["checkout", "."], { cwd: ctx.cwd });
							await pi.exec("git", ["clean", "-fd"], { cwd: ctx.cwd });
							currentAbortController = new AbortController();
							taskState.status = "completed";
							taskState.endTime = Date.now();
							await updateTodoFileStatus(ctx.cwd, task.id, "closed");
							task.status = "closed";
							// Update PRD Task Index
							try {
								const currentPrdBody = await readTodoBody(ctx.cwd, prdId);
								const updatedBody = updateTaskIndexBody(currentPrdBody, task.id, tasks);
								await updateTodoFileBody(ctx.cwd, prdId, updatedBody);
							} catch {
								// Non-critical
							}
							// Restart widget timer
							widgetTimer = setInterval(updateWidget, 1000);
							updateWidget();
							taskSucceeded = false; // Skip post-task actions (already handled)
							break; // Break switch → will break while loop below
						}

						case "abort":
							aborted = true;
							taskState.status = "aborted";
							taskState.endTime = Date.now();
							break; // Break switch → will break while loop below
					}

					if (aborted) break; // Break while loop
					if (taskState.status === "completed") break; // Break while loop (skip case)
					continue; // Safety fallback
				}

				// Success — break out of retry loop
				if (result.success) {
					taskSucceeded = true;
					break;
				}

				// Failure — check if retries are available
				taskState.errors = result.errors;
				if (retriesRemaining <= 0) {
					// No retries left — mark failed and stop the loop
					taskState.status = "failed";
					taskState.endTime = Date.now();
					updateWidget();

					cleanup("failed");
					ctx.ui.notify(
						`❌ Task failed: ${task.title} (after ${attempt} attempt${attempt > 1 ? "s" : ""})\nErrors: ${result.errors.join("; ")}`,
						"error",
					);
					return;
				}

				// Retry: build augmented prompt with error context
				retriesRemaining--;
				attempt++;
				taskState.retries++;
				taskState.status = "retrying";
				loopState.currentRetry = attempt - 1;
				updateWidget();

				currentPrompt = buildRetryPrompt(task, prdId, result.errors);
			}

			if (aborted) {
				if (taskState.status !== "aborted") {
					taskState.status = "aborted";
					taskState.endTime = Date.now();
				}
				break;
			}

			if (!taskSucceeded) continue;

			// --- Post-task actions on success ---
			taskState.status = "completed";
			taskState.endTime = Date.now();
			updateWidget();

			// 1. Git commit (smart or simple)
			const shortTitle = extractShortTitle(task.title);

			if (config.smartCommits) {
				// Spawn prd-committer subagent
				const committerResult = await spawnCommitterSubagent(
					ctx.cwd,
					prdTag,
					config.model,
					config.thinkingLevel,
					currentAbortController.signal,
				);

				loopState.totalCost += committerResult.cost;
				taskState.cost += committerResult.cost;

				if (committerResult.success) {
					loopState.totalCommits += committerResult.commitCount;
				} else {
					// Fallback to simple auto-commit
					const fallback = await simpleAutoCommit(pi, ctx.cwd, prdTag, task.sequenceLabel, shortTitle);
					if (fallback.committed) {
						loopState.totalCommits++;
					} else if (fallback.error) {
						ctx.ui.notify(`⚠️ Git commit warning: ${fallback.error}`, "warning");
					}
				}
			} else {
				// Simple auto-commit
				const commitResult = await simpleAutoCommit(pi, ctx.cwd, prdTag, task.sequenceLabel, shortTitle);
				if (commitResult.committed) {
					loopState.totalCommits++;
				} else if (commitResult.error) {
					ctx.ui.notify(`⚠️ Git commit warning: ${commitResult.error}`, "warning");
				}
			}

			// 2. Update task todo status to closed
			await updateTodoFileStatus(ctx.cwd, task.id, "closed");

			// 3. Update the task's in-memory status for subsequent index updates
			task.status = "closed";

			// 4. Update PRD Task Index
			try {
				const currentPrdBody = await readTodoBody(ctx.cwd, prdId);
				const updatedBody = updateTaskIndexBody(currentPrdBody, task.id, tasks);
				await updateTodoFileBody(ctx.cwd, prdId, updatedBody);
			} catch (err) {
				ctx.ui.notify(
					`⚠️ Failed to update PRD Task Index: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}

			updateWidget();
		}

		// --- Loop finished ---
		if (aborted) {
			cleanup("aborted");
			ctx.ui.notify("⚠️ Loop aborted. Uncommitted code left on disk.", "warning");
			return;
		}

		// All tasks complete — close PRD todo
		await updateTodoFileStatus(ctx.cwd, prdId, "closed");

		cleanup("completed");
		ctx.ui.notify(
			`🎉 PRD Loop complete! All ${resolution.actionable.length} task(s) executed successfully.`,
			"info",
		);
	} catch (err) {
		// Unexpected error — clean up
		cleanup("failed");
		throw err;
	}
}

// --- Main command handler ---

/**
 * Get a display string for a model in "provider/id" format.
 */
function modelDisplayId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

async function prdLoopHandler(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	// Step 0: Parse flags
	const flags = parseCommandArgs(args);
	if (flags.error) {
		ctx.ui.notify(flags.error, "error");
		return;
	}

	// Step 1: Git clean check
	const gitResult = await pi.exec("git", ["status", "--porcelain"]);
	if (gitResult.stdout.trim() !== "") {
		ctx.ui.notify(
			"Uncommitted changes detected. Please clean your working directory before starting the loop.",
			"error",
		);
		return;
	}

	// Step 2: PRD selection
	let selectedPrd: { prd: TodoItem; openTaskCount: number; totalTaskCount: number } | undefined;

	const activePrds = await getActivePrds(ctx.cwd);

	if (activePrds.length === 0) {
		ctx.ui.notify("No PRDs with open tasks found.", "error");
		return;
	}

	if (flags.prdTag) {
		// Direct selection via argument
		selectedPrd = activePrds.find((p) => p.prd.tags.includes(flags.prdTag!));
		if (!selectedPrd) {
			ctx.ui.notify(`No active PRD found with tag "${flags.prdTag}".`, "error");
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

	// Step 3: Configuration dialogs (skip if corresponding flag is set)

	// 3a. Retry fixes
	let retryFixes: number;
	if (flags.retryFixes !== null) {
		retryFixes = flags.retryFixes;
	} else {
		const retryInput = await ctx.ui.input("Retry fixes", "0");
		if (retryInput === undefined) return; // User cancelled
		const parsed = parseInt(retryInput, 10);
		if (isNaN(parsed) || parsed < 0) {
			ctx.ui.notify(`Invalid retry fixes value: "${retryInput}" (must be a non-negative integer)`, "error");
			return;
		}
		retryFixes = parsed;
	}

	// 3b. Smart commits
	let smartCommits: boolean;
	if (flags.smartCommits !== null) {
		smartCommits = flags.smartCommits;
	} else {
		smartCommits = await ctx.ui.confirm("Smart commits", "Use a subagent for granular conventional commits?");
	}

	// 3c. Model selection (filtered to current provider)
	let selectedModelId: string;
	let selectedModelObj: { provider: string; id: string; name: string; reasoning: boolean } | undefined;
	const currentModel = ctx.model;
	const currentModelId = currentModel ? modelDisplayId(currentModel) : undefined;
	const currentProvider = currentModel?.provider;

	if (flags.model !== null) {
		// Validate that the specified model exists
		const allModels = ctx.modelRegistry.getAvailable();
		const match = allModels.find((m) => modelDisplayId(m) === flags.model || m.id === flags.model);
		if (!match) {
			ctx.ui.notify(`Model not found: "${flags.model}"`, "error");
			return;
		}
		selectedModelId = modelDisplayId(match);
		selectedModelObj = match;
	} else {
		const allAvailableModels = ctx.modelRegistry.getAvailable();
		if (allAvailableModels.length === 0) {
			ctx.ui.notify("No models available. Please configure an API key.", "error");
			return;
		}

		// Filter to models from the current provider only
		const providerModels = currentProvider
			? allAvailableModels.filter((m) => m.provider === currentProvider)
			: allAvailableModels;

		if (providerModels.length === 0) {
			ctx.ui.notify(`No models available for provider "${currentProvider}".`, "error");
			return;
		}

		const modelOptions = providerModels.map((m) => {
			const id = modelDisplayId(m);
			return currentModelId === id ? `${m.name} (${id}) ★` : `${m.name} (${id})`;
		});

		const modelChoice = await ctx.ui.select(`Model (${currentProvider})`, modelOptions);
		if (modelChoice === undefined) return; // User cancelled

		const modelIndex = modelOptions.indexOf(modelChoice);
		if (modelIndex === -1) return;
		selectedModelId = modelDisplayId(providerModels[modelIndex]);
		selectedModelObj = providerModels[modelIndex];
	}

	// 3d. Thinking level selection (only for reasoning models)
	let thinkingLevel: string | undefined;
	if (flags.thinkingLevel !== null) {
		thinkingLevel = flags.thinkingLevel;
	} else if (selectedModelObj?.reasoning) {
		const thinkingLevels = ["minimal", "low", "medium", "high", "xhigh"];
		const currentThinking = pi.getThinkingLevel();

		const thinkingOptions = thinkingLevels.map((level) =>
			level === currentThinking ? `${level} ★` : level,
		);

		const thinkingChoice = await ctx.ui.select("Thinking level", thinkingOptions);
		if (thinkingChoice === undefined) return; // User cancelled

		const thinkingIndex = thinkingOptions.indexOf(thinkingChoice);
		if (thinkingIndex === -1) return;
		thinkingLevel = thinkingLevels[thinkingIndex];
	}

	// Build the config object
	const config: LoopConfig = {
		retryFixes,
		smartCommits,
		model: selectedModelId,
		thinkingLevel,
	};

	// Step 4: Confirmation dialog
	const completedCount = selectedPrd.totalTaskCount - selectedPrd.openTaskCount;
	const confirmMessage = [
		`🚀 Loop Configuration:`,
		`   PRD:           ${selectedPrd.prd.title}`,
		`   Tasks:         ${selectedPrd.openTaskCount} open, ${completedCount} completed`,
		`   Retry Fixes:   ${config.retryFixes}`,
		`   Smart Commits: ${config.smartCommits ? "Yes" : "No"}`,
		`   Model:         ${config.model}`,
		`   Thinking:      ${config.thinkingLevel ?? "off"}`,
		``,
		`Start loop?`,
	].join("\n");

	const confirmed = await ctx.ui.confirm("PRD Loop", confirmMessage);
	if (!confirmed) {
		return;
	}

	// Step 5: Run the orchestrator loop
	const selectedPrdTag = selectedPrd.prd.tags.find((t) => /^prd-\d+$/.test(t))!;
	await runOrchestratorLoop(ctx, pi, selectedPrd.prd, selectedPrdTag, config);
}

// --- Extension entry point ---

export default function prdLoopExtension(pi: ExtensionAPI): void {
	const commandConfig = {
		description: "Execute all tasks of a PRD autonomously with subagents",
		handler: (args: string, ctx: ExtensionCommandContext) => prdLoopHandler(args, ctx, pi),
	};

	pi.registerCommand("prd-loop", commandConfig);
	pi.registerCommand("ralph", {
		...commandConfig,
		description: "Alias for /prd-loop — Execute all tasks of a PRD autonomously",
	});
}
