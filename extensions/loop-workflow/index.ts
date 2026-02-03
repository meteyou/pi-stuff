/**
 * Loop Workflow Extension (Simplified)
 *
 * A simple iterative workflow for AI-assisted development.
 *
 * Commands:
 * - /loop init [goal]  - Plan what to do, LLM asks clarifying questions
 * - /loop run          - Execute tasks with subagents
 * - /loop status       - Show current progress
 * - /loop clear        - Clean up .pi/loop/ files
 */

import { readFile, writeFile, access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// File paths
const LOOP_DIR = ".pi/loop";
const PLAN_FILE = `${LOOP_DIR}/PLAN.md`;
const NOTES_FILE = `${LOOP_DIR}/NOTES.md`;
const LOG_FILE = `${LOOP_DIR}/LOG.md`;

// Types
interface Task {
	id: number;
	name: string;
	description: string;
	completed: boolean;
}

interface Plan {
	goal: string;
	context: string;
	tasks: Task[];
}

// Parse PLAN.md
function parsePlan(content: string): Plan {
	const plan: Plan = {
		goal: "",
		context: "",
		tasks: [],
	};

	const lines = content.split("\n");
	let section = "";
	let buffer: string[] = [];

	const flushBuffer = () => {
		const text = buffer.join("\n").trim();
		if (section === "goal") plan.goal = text;
		else if (section === "context") plan.context = text;
		buffer = [];
	};

	for (const line of lines) {
		if (line.startsWith("## Goal")) {
			flushBuffer();
			section = "goal";
			continue;
		} else if (line.startsWith("## Context")) {
			flushBuffer();
			section = "context";
			continue;
		} else if (line.startsWith("## Tasks")) {
			flushBuffer();
			section = "tasks";
			continue;
		} else if (line.startsWith("## ")) {
			flushBuffer();
			section = "";
			continue;
		}

		if (section === "goal" || section === "context") {
			buffer.push(line);
		} else if (section === "tasks") {
			// Parse task: "- [x] 1. Task name" or "- [ ] 1. Task name"
			const taskMatch = line.match(/^- \[(x| )\] (\d+)\. (.+)$/);
			if (taskMatch) {
				plan.tasks.push({
					id: parseInt(taskMatch[2]),
					name: taskMatch[3].trim(),
					description: "",
					completed: taskMatch[1] === "x",
				});
			}
			// Parse task description (indented lines after task)
			const descMatch = line.match(/^  (.+)$/);
			if (descMatch && plan.tasks.length > 0) {
				const lastTask = plan.tasks[plan.tasks.length - 1];
				lastTask.description += (lastTask.description ? "\n" : "") + descMatch[1];
			}
		}
	}

	flushBuffer();
	return plan;
}

// Generate PLAN.md
function generatePlan(plan: Plan): string {
	let content = "# Loop Workflow Plan\n\n";

	content += "## Goal\n";
	content += (plan.goal || "[Not defined yet]") + "\n\n";

	content += "## Context\n";
	content += (plan.context || "[Project context and constraints]") + "\n\n";

	content += "## Tasks\n";
	if (plan.tasks.length === 0) {
		content += "[No tasks defined yet]\n";
	} else {
		for (const task of plan.tasks) {
			const checkbox = task.completed ? "[x]" : "[ ]";
			content += `- ${checkbox} ${task.id}. ${task.name}\n`;
			if (task.description) {
				const descLines = task.description.split("\n");
				for (const descLine of descLines) {
					content += `  ${descLine}\n`;
				}
			}
		}
	}

	return content;
}

// Generate empty NOTES.md
function generateNotes(): string {
	return `# Notes

Important decisions and issues encountered during the project.

## Decisions
- [Important decisions will be documented here]

## Issues
- [Problems and blockers will be documented here]
`;
}

// Generate empty LOG.md
function generateLog(): string {
	const now = new Date().toISOString().split("T")[0];
	return `# Execution Log

## ${now}
- Loop workflow initialized
`;
}

// Helper to ensure directory exists
async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

// Helper to check if file exists
async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

// Helper to read plan
async function readPlan(cwd: string): Promise<Plan | null> {
	const planPath = join(cwd, PLAN_FILE);
	if (!(await fileExists(planPath))) {
		return null;
	}
	const content = await readFile(planPath, "utf-8");
	return parsePlan(content);
}

// Helper to write plan
async function writePlan(cwd: string, plan: Plan): Promise<void> {
	await ensureDir(join(cwd, LOOP_DIR));
	await writeFile(join(cwd, PLAN_FILE), generatePlan(plan), "utf-8");
}

// Helper to initialize notes and log
async function initializeFiles(cwd: string): Promise<void> {
	await ensureDir(join(cwd, LOOP_DIR));
	
	const notesPath = join(cwd, NOTES_FILE);
	if (!(await fileExists(notesPath))) {
		await writeFile(notesPath, generateNotes(), "utf-8");
	}
	
	const logPath = join(cwd, LOG_FILE);
	if (!(await fileExists(logPath))) {
		await writeFile(logPath, generateLog(), "utf-8");
	}
}

export default function loopWorkflowExtension(pi: ExtensionAPI): void {
	// Update status in footer
	function updateStatus(ctx: ExtensionContext, plan: Plan | null): void {
		if (!plan || plan.tasks.length === 0) {
			ctx.ui.setStatus("loop", "");
			return;
		}

		const total = plan.tasks.length;
		const completed = plan.tasks.filter((t) => t.completed).length;
		const percent = Math.round((completed / total) * 100);

		const status = ctx.ui.theme.fg("accent", `📋 ${completed}/${total} (${percent}%)`);
		ctx.ui.setStatus("loop", status);
	}

	// Command: /loop
	pi.registerCommand("loop", {
		description: "Loop workflow (init|run|status|clear)",
		getArgumentCompletions: (prefix: string) => {
			const cmds = ["init", "run", "status", "clear", "help"];
			const filtered = cmds.filter((c) => c.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = (args || "").trim().split(/\s+/);
			const cwd = ctx.cwd;

			switch (subcommand) {
				case "init": {
					const existingPlan = await readPlan(cwd);
					if (existingPlan && existingPlan.tasks.length > 0) {
						const overwrite = await ctx.ui.confirm(
							"Plan exists",
							"A plan already exists. Start fresh?"
						);
						if (!overwrite) {
							ctx.ui.notify("Cancelled.", "info");
							return;
						}
					}

					// Get initial goal from args or ask
					let initialGoal = rest.join(" ").trim();

					// Create empty plan structure
					const plan: Plan = {
						goal: initialGoal,
						context: "",
						tasks: [],
					};
					await writePlan(cwd, plan);
					await initializeFiles(cwd);

					ctx.ui.notify("Loop initialized! Let's plan your project.", "success");

					pi.sendUserMessage(`# Loop Workflow - Planning Phase

I've created the following files in \`.pi/loop/\`:
- **PLAN.md** - Goal, context, and task list
- **NOTES.md** - For important decisions and issues
- **LOG.md** - Execution log (automatically updated)

${initialGoal ? `**Initial Goal:** ${initialGoal}` : ""}

## Your Task

Help me define a clear plan by:

1. **Understanding the Goal**
   ${initialGoal ? "Confirm or refine the goal above." : "Ask me what I want to build/achieve."}

2. **Asking Clarifying Questions**
   Ask me ALL questions you need answered to create a good plan:
   - What is the expected outcome?
   - What technologies/tools should be used?
   - Are there constraints or preferences?
   - What already exists vs. needs to be created?
   - What's the scope (what's NOT included)?

3. **Creating the Task List**
   Once you have enough information, update \`.pi/loop/PLAN.md\` with:
   - A clear goal statement
   - Context (tech stack, constraints, decisions)
   - A numbered list of atomic tasks

## Task Format in PLAN.md
\`\`\`markdown
## Tasks
- [ ] 1. Task name
  Description of what to do and how to verify it's done
- [ ] 2. Next task
  Description...
\`\`\`

**Important:** Each task should be:
- Atomic (completable in one focused session)
- Verifiable (clear "done" criteria)
- Independent (minimal dependencies on other tasks)

Start by asking me your questions!

---

## ⚠️ STOP AFTER PLANNING

**DO NOT** start executing tasks after creating the plan!

Once the plan is finalized in PLAN.md:
1. Show a summary of the tasks
2. Tell the user to review the plan
3. **STOP and WAIT** for the user to run \`/loop run\`

The user must explicitly trigger execution with \`/loop run\`.`);
					break;
				}

				case "run": {
					const plan = await readPlan(cwd);
					if (!plan) {
						ctx.ui.notify("No plan found. Run /loop init first.", "error");
						return;
					}

					if (plan.tasks.length === 0) {
						ctx.ui.notify("No tasks defined. Complete /loop init first.", "error");
						return;
					}

					const pendingTasks = plan.tasks.filter((t) => !t.completed);

					if (pendingTasks.length === 0) {
						ctx.ui.notify("All tasks completed! 🎉", "success");
						return;
					}

					// Confirm before running
					const confirm = await ctx.ui.confirm(
						"Run Tasks",
						`Execute ${pendingTasks.length} pending task(s) with subagents?\n\n${pendingTasks.map((t) => `• ${t.id}. ${t.name}`).join("\n")}`
					);

					if (!confirm) {
						ctx.ui.notify("Cancelled.", "info");
						return;
					}

					updateStatus(ctx, plan);

					// Build subagent chain
					const chainSteps = pendingTasks.map((task) => ({
						agent: "loop-worker",
						task: `# Task ${task.id}: ${task.name}

${task.description || "No additional description."}

## Instructions
1. Read \`.pi/loop/PLAN.md\` for context (goal, other tasks)
2. Execute this task
3. Verify it works
4. **IMMEDIATELY** update \`.pi/loop/PLAN.md\`:
   Change \`- [ ] ${task.id}. ${task.name}\` to \`- [x] ${task.id}. ${task.name}\`
5. Add a log entry to \`.pi/loop/LOG.md\` with timestamp

## Important
- Do NOT commit changes (user will decide when to commit)
- Do NOT proceed to other tasks
- Update PLAN.md and LOG.md BEFORE reporting completion

## If Blocked
- Document the issue in \`.pi/loop/NOTES.md\` under "## Issues"
- Stop and report the problem`,
					}));

					pi.sendUserMessage(`# Execute Loop Tasks

Use the subagent tool to run ${pendingTasks.length} task(s) sequentially.

## Plan Context
**Goal:** ${plan.goal}

**Context:** ${plan.context || "None specified"}

## Chain Configuration
\`\`\`json
{
  "chain": ${JSON.stringify(chainSteps, null, 2)},
  "agentScope": "both"
}
\`\`\`

## Execution Rules
1. Execute tasks **one at a time**
2. After EACH task: **immediately** update PLAN.md (mark [x]) and LOG.md
3. Do NOT batch updates - update files after EVERY single task
4. Do NOT commit automatically - user will decide when to commit
5. If subagent tool is unavailable, execute tasks manually but follow the same rules

## If No Subagent Available
Execute each task yourself, but strictly follow:
- Complete task 1 → Update PLAN.md → Update LOG.md → Report
- Complete task 2 → Update PLAN.md → Update LOG.md → Report
- (continue for each task)

Stop if a task fails and report the issue.`);
					break;
				}

				case "status": {
					const plan = await readPlan(cwd);
					if (!plan) {
						ctx.ui.notify("No plan found. Run /loop init first.", "error");
						return;
					}

					updateStatus(ctx, plan);

					const total = plan.tasks.length;
					const completed = plan.tasks.filter((t) => t.completed).length;
					const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

					let output = `# Loop Status\n\n`;
					output += `**Goal:** ${plan.goal || "(not defined)"}\n\n`;
					output += `**Progress:** ${completed}/${total} tasks (${percent}%)\n\n`;

					if (plan.tasks.length > 0) {
						output += `## Tasks\n`;
						for (const task of plan.tasks) {
							const icon = task.completed ? "✅" : "⬚";
							const style = task.completed ? "~~" : "";
							output += `${icon} ${style}${task.id}. ${task.name}${style}\n`;
						}
						output += "\n";
					}

					const nextTask = plan.tasks.find((t) => !t.completed);
					if (nextTask) {
						output += `**Next:** ${nextTask.id}. ${nextTask.name}\n`;
					} else if (total > 0) {
						output += `**Status:** All tasks completed! 🎉\n`;
					}

					ctx.ui.notify(output, "info");
					break;
				}

				case "clear": {
					const loopDir = join(cwd, LOOP_DIR);
					if (!(await fileExists(loopDir))) {
						ctx.ui.notify("Nothing to clear. No .pi/loop/ directory found.", "info");
						return;
					}

					const confirm = await ctx.ui.confirm(
						"Clear Loop",
						"Delete all files in .pi/loop/? This cannot be undone."
					);

					if (!confirm) {
						ctx.ui.notify("Cancelled.", "info");
						return;
					}

					await rm(loopDir, { recursive: true, force: true });
					ctx.ui.setStatus("loop", "");

					ctx.ui.notify("Cleared .pi/loop/ directory.", "success");
					break;
				}

				case "help":
				default: {
					ctx.ui.notify(
						`Loop Workflow Commands:
  /loop init [goal]  - Start planning (LLM asks questions, creates tasks)
  /loop run          - Execute all pending tasks with subagents
  /loop status       - Show current progress
  /loop clear        - Delete .pi/loop/ files`,
						"info"
					);
					break;
				}
			}
		},
	});

	// Restore status on session start
	pi.on("session_start", async (_event, ctx) => {
		const plan = await readPlan(ctx.cwd);
		if (plan) {
			updateStatus(ctx, plan);
		}
	});
}
