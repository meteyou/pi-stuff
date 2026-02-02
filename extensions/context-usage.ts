/**
 * Context Usage Extension
 *
 * Displays a visual representation of context window usage similar to Claude Code.
 * Registers the /context command.
 *
 * Features:
 * - Visual grid representation of the context window
 * - Breakdown by System Prompt and Messages with tree structure
 * - Tracking of read files (via read tool)
 * - Tracking of loaded skills (via /skill:name)
 * - Status display in footer
 *
 * Usage: pi -e ./extensions/context-usage.ts
 *        then: /context
 */

import { type ExtensionAPI, type ExtensionContext, SettingsManager, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

// Symbols for visual representation
const FILLED = "⛁"; // Filled
const EMPTY = "⛶"; // Empty
const RESERVED = "⛝"; // Reserved for compaction

// Grid configuration
const GRID_WIDTH = 10;
const GRID_HEIGHT = 10;
const TOTAL_CELLS = GRID_WIDTH * GRID_HEIGHT;

// Tracking for read files
interface ReadFile {
	path: string;
	tokens: number;
	timestamp: number;
}

// AGENTS.md / CLAUDE.md files
interface AgentsFile {
	path: string;
	tokens: number;
}

// Loaded skill (via /skill:name)
interface LoadedSkill {
	name: string;
	tokens: number;
	timestamp: number;
}

// Global state for read files and loaded skills in the session
let readFiles: Map<string, ReadFile> = new Map();
let loadedSkills: Map<string, LoadedSkill> = new Map();

// Find all AGENTS.md/CLAUDE.md files in the project
function findAgentsFiles(cwd: string): AgentsFile[] {
	const files: AgentsFile[] = [];
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	
	let currentDir = cwd;
	const visited = new Set<string>();
	
	// Search from cwd to root
	while (currentDir && !visited.has(currentDir)) {
		visited.add(currentDir);
		
		for (const filename of candidates) {
			const filePath = join(currentDir, filename);
			try {
				if (existsSync(filePath) && statSync(filePath).isFile()) {
					const content = readFileSync(filePath, "utf-8");
					const tokens = estimateTokens(content);
					files.push({ path: filePath, tokens });
					// Only one per directory (AGENTS.md takes precedence)
					break;
				}
			} catch {
				// Ignore errors
			}
		}
		
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	
	// Also check .pi/ directory
	const piAgentsPath = join(cwd, ".pi", "AGENTS.md");
	try {
		if (existsSync(piAgentsPath) && statSync(piAgentsPath).isFile()) {
			const content = readFileSync(piAgentsPath, "utf-8");
			const tokens = estimateTokens(content);
			files.push({ path: piAgentsPath, tokens });
		}
	} catch {
		// Ignore
	}
	
	return files;
}

// Extract skills directory tokens from system prompt
function extractSkillsDirectoryTokens(systemPrompt: string): number {
	const match = systemPrompt.match(/<available_skills>([\s\S]*?)<\/available_skills>/);
	if (!match) return 0;
	
	// Include the intro text as well
	const introMatch = systemPrompt.match(/The following skills provide specialized instructions[\s\S]*?<available_skills>/);
	const intro = introMatch ? introMatch[0].replace(/<available_skills>$/, '') : '';
	
	return estimateTokens(intro + match[0]);
}

interface UsageBreakdown {
	// System Prompt components
	systemPromptTotal: number;
	systemPromptBase: number;
	systemTools: number;
	skillsDirectory: number;
	agentsTokens: number;
	
	// Messages components
	messagesTotal: number;
	loadedSkillsTokens: number;
	otherMessages: number;
	
	// Other
	freeSpace: number;
	reserveTokens: number;
	total: number;
	contextWindow: number;
	percent: number;
	model: string;
	
	// Details
	readFiles: ReadFile[];
	agentsFiles: AgentsFile[];
	loadedSkills: LoadedSkill[];
}

function estimateTokens(text: string): number {
	// Rough estimate: 4 characters = 1 token (pi's standard heuristic)
	return Math.ceil(text.length / 4);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000000) {
		return `${(tokens / 1000000).toFixed(1)}M`;
	}
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	return `${tokens}`;
}

function shortenPath(path: string, maxLen: number = 40): string {
	if (path.length <= maxLen) return path;
	const parts = path.split("/");
	if (parts.length <= 2) return path.slice(-maxLen);
	// Shorten middle parts
	return "…/" + parts.slice(-2).join("/");
}

function getUsageBreakdown(ctx: ExtensionContext, pi: ExtensionAPI): UsageBreakdown | null {
	const usage = ctx.getContextUsage();
	if (!usage) return null;

	const model = ctx.model;
	if (!model) return null;

	// Estimate system prompt tokens
	const systemPrompt = ctx.getSystemPrompt();
	const systemPromptTotal = estimateTokens(systemPrompt);

	// Find AGENTS.md files
	const agentsFiles = findAgentsFiles(ctx.cwd);
	const agentsTokens = agentsFiles.reduce((sum, f) => sum + f.tokens, 0);
	
	// Extract skills directory tokens from system prompt
	const skillsDirectory = extractSkillsDirectoryTokens(systemPrompt);
	
	// Estimate tools tokens
	const tools = pi.getAllTools();
	let systemTools = 0;
	for (const tool of tools) {
		// Tool name + description + parameter schema overhead
		systemTools += estimateTokens(tool.name + " " + tool.description) + 100;
	}
	
	// System prompt base (without AGENTS.md, skills directory, and tools estimation)
	const systemPromptBase = Math.max(0, systemPromptTotal - agentsTokens - skillsDirectory);

	// Reserve tokens for compaction
	const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());
	const reserveTokens = settingsManager.getCompactionReserveTokens();

	// Messages = Total - System - Tools
	const messagesTotal = Math.max(0, usage.tokens - systemPromptTotal - systemTools);

	// Loaded skills tokens
	const sortedLoadedSkills = Array.from(loadedSkills.values()).sort((a, b) => b.tokens - a.tokens);
	const loadedSkillsTokens = sortedLoadedSkills.reduce((sum, s) => sum + s.tokens, 0);
	const otherMessages = Math.max(0, messagesTotal - loadedSkillsTokens);

	// Free space = Context Window - Used - Reserve
	const freeSpace = Math.max(0, usage.contextWindow - usage.tokens - reserveTokens);

	// Sort read files by tokens (largest first)
	const sortedReadFiles = Array.from(readFiles.values()).sort((a, b) => b.tokens - a.tokens);

	return {
		systemPromptTotal,
		systemPromptBase,
		systemTools,
		skillsDirectory,
		agentsTokens,
		messagesTotal,
		loadedSkillsTokens,
		otherMessages,
		freeSpace,
		reserveTokens,
		total: usage.tokens,
		contextWindow: usage.contextWindow,
		percent: usage.percent,
		model: `${model.provider}/${model.id}`,
		readFiles: sortedReadFiles,
		agentsFiles,
		loadedSkills: sortedLoadedSkills,
	};
}

function renderGrid(breakdown: UsageBreakdown, theme: any): string[] {
	const lines: string[] = [];

	// Calculate cells per category
	const cellsPerToken = TOTAL_CELLS / breakdown.contextWindow;

	// Only 2 main categories for the grid
	const systemPromptWithTools = breakdown.systemPromptTotal + breakdown.systemTools;
	const systemCells = Math.ceil(systemPromptWithTools * cellsPerToken);
	const messagesCells = Math.ceil(breakdown.messagesTotal * cellsPerToken);
	const reservedCells = Math.ceil(breakdown.reserveTokens * cellsPerToken);
	
	// Calculate boundaries
	const systemEnd = systemCells;
	const messagesEnd = systemEnd + messagesCells;

	// Create grid with color-coded cells
	const grid: { symbol: string; color: string }[] = [];
	for (let i = 0; i < TOTAL_CELLS; i++) {
		if (i < systemEnd) {
			// System Prompt - dim
			grid.push({ symbol: FILLED, color: "dim" });
		} else if (i < messagesEnd) {
			// Messages - success (green)
			grid.push({ symbol: FILLED, color: "success" });
		} else if (i >= TOTAL_CELLS - reservedCells) {
			// Compaction reserve - muted
			grid.push({ symbol: RESERVED, color: "muted" });
		} else {
			// Free space - dim
			grid.push({ symbol: EMPTY, color: "dim" });
		}
	}

	// Create legend as tree structure
	const systemPromptWithToolsTokens = breakdown.systemPromptTotal + breakdown.systemTools;
	const systemPercent = ((systemPromptWithToolsTokens / breakdown.contextWindow) * 100).toFixed(1);
	const messagesPercent = ((breakdown.messagesTotal / breakdown.contextWindow) * 100).toFixed(1);
	
	const legend: string[] = [
		`${theme.fg("accent", `${breakdown.model}`)} · ${formatTokens(breakdown.total)}/${formatTokens(breakdown.contextWindow)} tokens (${breakdown.percent.toFixed(0)}%)`,
		``,
		// System Prompt tree
		`${theme.fg("dim", FILLED)} System Prompt: ${formatTokens(systemPromptWithToolsTokens)} tokens (${systemPercent}%)`,
		`    ${theme.fg("dim", "├")} SYSTEM.md: ${formatTokens(breakdown.systemPromptBase)} tokens`,
		`    ${theme.fg("dim", "├")} Tools: ${formatTokens(breakdown.systemTools)} tokens`,
	];
	
	// Add skills directory if present
	if (breakdown.skillsDirectory > 0) {
		legend.push(`    ${theme.fg("dim", "├")} Skills: ${formatTokens(breakdown.skillsDirectory)} tokens`);
	}
	
	// Add AGENTS.md if present
	if (breakdown.agentsTokens > 0) {
		legend.push(`    ${theme.fg("dim", "└")} AGENTS.md: ${formatTokens(breakdown.agentsTokens)} tokens`);
	} else {
		// Fix last item to use └
		const lastIndex = legend.length - 1;
		legend[lastIndex] = legend[lastIndex].replace("├", "└");
	}
	
	legend.push(``);
	
	// Messages tree
	legend.push(`${theme.fg("success", FILLED)} Messages: ${formatTokens(breakdown.messagesTotal)} tokens (${messagesPercent}%)`);
	
	if (breakdown.loadedSkillsTokens > 0) {
		legend.push(`    ${theme.fg("success", "├")} Loaded skills: ${formatTokens(breakdown.loadedSkillsTokens)} tokens`);
		legend.push(`    ${theme.fg("success", "└")} Context: ${formatTokens(breakdown.otherMessages)} tokens`);
		legend.push(``);
	}

	legend.push(`${theme.fg("dim", EMPTY)} Free space: ${formatTokens(breakdown.freeSpace)} (${((breakdown.freeSpace / breakdown.contextWindow) * 100).toFixed(1)}%)`);
	legend.push(`${theme.fg("muted", RESERVED)} Compaction reserve: ${formatTokens(breakdown.reserveTokens)} tokens`);

	// Combine grid and legend
	for (let row = 0; row < GRID_HEIGHT; row++) {
		let gridLine = "";
		for (let col = 0; col < GRID_WIDTH; col++) {
			const idx = row * GRID_WIDTH + col;
			const cell = grid[idx];
			gridLine += theme.fg(cell.color, cell.symbol) + " ";
		}

		// Legend next to grid
		if (row < legend.length) {
			gridLine += "  " + legend[row];
		}

		lines.push(gridLine);
	}

	return lines;
}

function renderReadFiles(breakdown: UsageBreakdown, theme: any): string[] {
	const lines: string[] = [];

	if (breakdown.readFiles.length === 0) {
		lines.push(theme.fg("dim", "  No files read in this session"));
		return lines;
	}

	// Show top files (max 10)
	const topFiles = breakdown.readFiles.slice(0, 10);
	const totalFileTokens = breakdown.readFiles.reduce((sum, f) => sum + f.tokens, 0);

	lines.push(
		`  ${theme.fg("accent", breakdown.readFiles.length.toString())} files read · ${formatTokens(totalFileTokens)} tokens total`
	);
	lines.push("");

	for (const file of topFiles) {
		const percent = ((file.tokens / breakdown.contextWindow) * 100).toFixed(1);
		const shortPath = shortenPath(file.path);
		lines.push(`  ${theme.fg("dim", "└")} ${shortPath}: ${formatTokens(file.tokens)} (${percent}%)`);
	}

	if (breakdown.readFiles.length > 10) {
		const remaining = breakdown.readFiles.length - 10;
		lines.push(theme.fg("dim", `  ... and ${remaining} more files`));
	}

	return lines;
}

function renderAgentsFiles(breakdown: UsageBreakdown, theme: any): string[] {
	const lines: string[] = [];

	const totalTokens = breakdown.agentsFiles.reduce((sum, f) => sum + f.tokens, 0);
	lines.push(
		`  ${theme.fg("accent", breakdown.agentsFiles.length.toString())} files · ${formatTokens(totalTokens)} tokens total`
	);
	lines.push("");

	for (const file of breakdown.agentsFiles) {
		const percent = ((file.tokens / breakdown.contextWindow) * 100).toFixed(1);
		const shortPath = shortenPath(file.path, 50);
		lines.push(`  ${theme.fg("dim", "└")} ${shortPath}: ${formatTokens(file.tokens)} (${percent}%)`);
	}

	return lines;
}

function renderLoadedSkills(breakdown: UsageBreakdown, theme: any): string[] {
	const lines: string[] = [];

	const totalTokens = breakdown.loadedSkills.reduce((sum, s) => sum + s.tokens, 0);
	lines.push(
		`  ${theme.fg("accent", breakdown.loadedSkills.length.toString())} skills loaded · ${formatTokens(totalTokens)} tokens total`
	);
	lines.push("");

	for (const skill of breakdown.loadedSkills) {
		const percent = ((skill.tokens / breakdown.contextWindow) * 100).toFixed(1);
		lines.push(`  ${theme.fg("dim", "└")} ${skill.name}: ${formatTokens(skill.tokens)} (${percent}%)`);
	}

	return lines;
}

export default function (pi: ExtensionAPI) {
	// Reset on new session
	pi.on("session_start", async () => {
		readFiles = new Map();
		loadedSkills = new Map();
	});

	pi.on("session_switch", async (event) => {
		if (event.reason === "new") {
			readFiles = new Map();
			loadedSkills = new Map();
		}
	});

	// Track read tool calls
	pi.on("tool_result", async (event) => {
		if (event.toolName === "read" && !event.isError) {
			const path = (event.input as any)?.path;
			if (path && event.content) {
				// Extract text content
				let textContent = "";
				for (const block of event.content) {
					if (block.type === "text") {
						textContent += block.text;
					}
				}

				if (textContent) {
					const tokens = estimateTokens(textContent);
					readFiles.set(path, {
						path,
						tokens,
						timestamp: Date.now(),
					});
				}
			}
		}
	});

	// Track skill loading via input event
	pi.on("input", async (event) => {
		const text = event.text;
		if (text.startsWith("/skill:")) {
			const spaceIndex = text.indexOf(" ");
			const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
			
			// Mark that this skill was loaded
			if (skillName && !loadedSkills.has(skillName)) {
				loadedSkills.set(skillName, {
					name: skillName,
					tokens: 0,
					timestamp: Date.now(),
				});
			}
		}
		return { action: "continue" as const };
	});

	// Track actual skill content from messages
	pi.on("before_agent_start", async (event, ctx) => {
		const text = event.prompt;
		// Check for expanded skill format: <skill name="..." location="...">content</skill>
		const skillMatch = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>/);
		if (skillMatch) {
			const [fullMatch, name, _location, content] = skillMatch;
			const tokens = estimateTokens(fullMatch);
			loadedSkills.set(name, {
				name,
				tokens,
				timestamp: Date.now(),
			});
		}
	});

	pi.registerCommand("context", {
		description: "Display context window usage visually",
		handler: async (_args, ctx) => {
			const breakdown = getUsageBreakdown(ctx, pi);
			if (!breakdown) {
				ctx.ui.notify("No context information available", "warning");
				return;
			}

			const theme = ctx.ui.theme;

			// Header
			const header = theme.bold(theme.fg("accent", "Context Usage"));

			// Render grid with tree legend
			const gridLines = renderGrid(breakdown, theme);

			// Render AGENTS.md files (only if present)
			let agentsSection: string[] = [];
			if (breakdown.agentsTokens > 0) {
				const agentsHeader = theme.bold(theme.fg("accent", "AGENTS.md / CLAUDE.md"));
				const agentsLines = renderAgentsFiles(breakdown, theme);
				agentsSection = ["", agentsHeader, "", ...agentsLines];
			}

			// Render loaded skills (only if present)
			let skillsSection: string[] = [];
			if (breakdown.loadedSkillsTokens > 0) {
				const skillsHeader = theme.bold(theme.fg("accent", "Loaded Skills"));
				const skillsLines = renderLoadedSkills(breakdown, theme);
				skillsSection = ["", skillsHeader, "", ...skillsLines];
			}

			// Render read files
			const filesHeader = theme.bold(theme.fg("accent", "Read Files"));
			const fileLines = renderReadFiles(breakdown, theme);

			// Display as widget
			const content = [
				"",
				header,
				"",
				...gridLines,
				...agentsSection,
				...skillsSection,
				"",
				filesHeader,
				"",
				...fileLines,
				"",
				theme.fg("dim", "Press any key to close..."),
				"",
			];

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const component = new Text(content.join("\n"), 1, 1);

				component.handleInput = (data) => {
					done();
					return true;
				};

				return component;
			});
		},
	});

	// Status update after each turn
	pi.on("turn_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (usage) {
			const theme = ctx.ui.theme;
			const percent = usage.percent.toFixed(0);
			const tokens = formatTokens(usage.tokens);

			let color: "success" | "warning" | "error" = "success";
			if (usage.percent > 70) color = "warning";
			if (usage.percent > 85) color = "error";

			ctx.ui.setStatus(
				"context",
				theme.fg(color, `⛁ ${tokens}/${formatTokens(usage.contextWindow)} (${percent}%)`)
			);
		}
	});
}
