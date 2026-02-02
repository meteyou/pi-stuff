# Loop Workflow Extension

A simple iterative workflow for AI-assisted development using Pi.

## Concept

This extension helps you:
1. **Plan** - Define what you want to build, the LLM asks clarifying questions
2. **Execute** - Subagents work through tasks automatically
3. **Track** - See progress at any time

## Commands

| Command | Description |
|---------|-------------|
| `/loop init [goal]` | Start planning - LLM asks questions, creates task list |
| `/loop run` | Execute all pending tasks with subagents |
| `/loop status` | Show current progress |
| `/loop clear` | Delete .pi/loop/ files |

## File Structure

```
.pi/loop/
├── PLAN.md     # Goal, context, and tasks (compact)
├── NOTES.md    # Important decisions and issues
└── LOG.md      # Execution log (can grow large)
```

### PLAN.md - The Plan (compact)

```markdown
# Loop Workflow Plan

## Goal
Build a CLI tool for managing Docker containers

## Context
- Using Node.js 20+ with TypeScript
- Commander.js for CLI parsing
- Must work offline

## Tasks
- [x] 1. Set up project structure
  Create package.json, tsconfig.json, and src/ directory
- [ ] 2. Implement CLI parser
  Use Commander.js to parse commands: start, stop, list
- [ ] 3. Add Docker API integration
  Use dockerode to communicate with Docker daemon
```

### NOTES.md - Important Notes

```markdown
# Notes

## Decisions
- Using Commander.js over yargs for smaller bundle size
- Config files will be YAML for readability

## Issues
- Docker socket permission issue on Linux - resolved with group membership
```

### LOG.md - Execution Log

```markdown
# Execution Log

## 2024-01-15
- Loop workflow initialized
- Task 1 completed: Project structure created
- Task 2 completed: CLI parser implemented

## 2024-01-16
- Task 3 started
- Task 3 completed: Docker API integration
```

## Workflow

```
┌─────────────────────────────────────────┐
│         1. /loop init                   │
│    "I want to build a CLI tool"         │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│      2. LLM asks questions              │
│    - What's the expected outcome?       │
│    - What tech stack?                   │
│    - What constraints?                  │
│    Creates PLAN.md, NOTES.md, LOG.md    │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│         3. /loop run                    │
│    Subagents execute tasks              │
│    Log progress to LOG.md               │
└────────────────────┬────────────────────┘
                     │
         ┌──────────┴──────────┐
         │                     │
         ▼                     ▼
   More tasks?           All done! 🎉
         │
         ▼
   /loop run (again)
```

## Example Session

```bash
# 1. Start planning
/loop init "Build a markdown to HTML converter"

# 2. LLM asks questions, you answer
# LLM creates PLAN.md with tasks

# 3. Check what was planned
/loop status

# 4. Execute all tasks
/loop run

# 5. Check progress anytime
/loop status

# 6. Clean up when done
/loop clear
```

## Requirements

For `/loop run` to work with subagents:
- The **subagent extension** must be installed
- Agent `loop-worker` must exist in `.pi/agents/` or `~/.pi/agents/`

## Execution Rules

The extension enforces these rules during `/loop run`:

1. **One task at a time** - Tasks are executed sequentially
2. **Immediate updates** - PLAN.md and LOG.md are updated after EACH task
3. **No automatic commits** - You decide when to commit changes
4. **Fail fast** - Execution stops if a task fails

This ensures progress is always tracked and recoverable.

## Best Practices

### 1. Be Specific in Init
```bash
# Good
/loop init "Build a REST API for user management with Node.js and PostgreSQL"

# Too vague
/loop init "Build an API"
```

### 2. Answer Questions Thoroughly
The more context you provide during planning, the better the task list.

### 3. Atomic Tasks
Each task should be:
- Completable in one focused session (~15-30 min)
- Have clear verification criteria
- Be relatively independent

### 4. Check Status Regularly
Use `/loop status` to see what's done and what's next.

### 5. Commit When Ready
The workflow does NOT auto-commit. Review changes and commit when you're satisfied:
```bash
git add -A && git commit -m "feat: completed loop tasks"
```

## Status Display

The footer shows progress when a plan exists:
- `📋 3/5 (60%)` - 3 of 5 tasks completed
