# pi-stuff

This repository contains my personal collection of resources for the [pi](https://buildwithpi.ai/) coding agent. It
serves as a comprehensive package to enhance the capabilities of `pi` with custom tools, workflows, and aesthetic
configurations.

Here you will find:
- **Skills**: Reusable capabilities that teach `pi` how to perform specific tasks (e.g., browsing the web, managing tmux
  sessions).
- **Extensions**: Add-ons that extend the core functionality of the agent.
- **Prompts**: Curated system prompts and templates to steer the agent's behavior.
- **Themes**: Custom color schemes to personalize the TUI experience.

Feel free to explore, use, and modify these resources to build your own perfect coding assistant environment.

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [PRD Workflow](docs/prd-workflow.md) | End-to-end guide for the `grill-me` → `write-a-prd` → `prd-to-todos` → `/prd-loop` workflow |

## 🚀 Installation

Install the package directly using the `pi` CLI:

```bash
pi install https://github.com/meteyou/pi-stuff.git
```

This clones the repo, runs `npm install` to fetch third-party dependencies (e.g. the `todos` tool from
[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)), and makes all skills, extensions, themes, and
prompts available immediately.

### Updating

Update the package (including third-party dependencies) with:

```bash
pi update
```

Then run `/reload` in pi or restart your session.

### Note to Self: Updating Third-Party Dependencies

When upstream dependencies (e.g. `mitsuhiko/agent-stuff`) have new changes, update and commit the lock file so users get
them via `pi update`:

```bash
npm update
git add package-lock.json
git commit -m "chore: update dependencies"
git push
```

## Extensions

| Extension | Description | Command | Source |
|-----------|-------------|---------|--------|
| `answer` | Extracts open questions from the last assistant message and opens an interactive Q&A flow to submit structured answers. | `/answer` (+ `Ctrl+.`) | custom, based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `claude-code-version` | Overrides Pi's Anthropic `user-agent` header so OAuth Anthropic requests advertise Claude Code `2.1.94` without patching `pi-ai`. | — | custom |
| `context-usage` | Displays a visual representation of context window usage similar to Claude Code. Shows breakdown by System Prompt, Messages, and Files. | `/context` | custom |
| `prd-loop` | Autonomous PRD task orchestrator. Spawns isolated subagents per task, auto-commits, retries on failure, shows a live overlay with task navigation/details, and leaves a summary widget afterward. Supports `--smart-commits` for granular conventional commits. Part of the [PRD Workflow](docs/prd-workflow.md). | `/prd-loop` (alias: `/ralph`) | custom |
| `quota-antigravity` | Displays the current quota usage for Antigravity models, including remaining prompt credits and model-specific limits. | `/quota-antigravity` | custom |
| `quota-claude` | Displays Claude Pro/Max subscription usage (5-hour and 7-day limits) in the footer. Only visible when using Anthropic models. | `/quota-claude` | custom |
| `quota-codex` | Displays ChatGPT Plus/Pro (OpenAI Codex) usage windows in the footer when using provider `openai-codex`. | `/quota-openai` (alias: `/quota-codex`) | custom |
| `review` | Flexible code-review workflow (uncommitted/branch/commit/PR/folder/custom) with review loop and auto-fixing. | `/review`, `/end-review` | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `session-breakdown` | Interactive breakdown of session usage (sessions/messages/tokens/cost) with heatmap, model table, and breakdowns by CWD, day of week, and time of day. | `/session-breakdown` | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `todos` | File-based todo manager with claiming, locking, and garbage collection. Includes a visual `/todos` TUI and a `todo` tool for the LLM. | `/todos` | custom, fork of [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `ghostty` | Ghostty terminal integration — dynamic title bar, progress indicators, and error states. | — | [pi-ghostty](https://github.com/HazAT/pi-ghostty) |

## Skills

| Skill | Description | Source |
|-------|-------------|--------|
| `frontend-design` | Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when building web components, pages, dashboards, apps, or when beautifying any web UI. | [anthropics/skills](https://github.com/anthropics/skills/blob/main/skills/frontend-design/LICENSE.txt) |
| `github` | Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `grill-me` | Interview the user relentlessly about a plan or design until reaching shared understanding. Summarizes decisions and offers handoff to `write-a-prd`. Part of the [PRD Workflow](docs/prd-workflow.md). | [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/grill-me) |
| `pi-share` | Load and parse session transcripts from pi-share URLs (shittycodingagent.ai, buildwithpi.ai, buildwithpi.com, pi.dev). Fetches gists, decodes embedded session data, and extracts conversation history. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `prd-to-todos` | Break a PRD into sequenced, dependency-aware tasks with `PRD #N - Task M/T:` titles. Updates the PRD with a Task Index for status tracking. Part of the [PRD Workflow](docs/prd-workflow.md). | custom, based on [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/prd-to-issues) |
| `skill-creator` | Guide for creating effective skills. Use to create new skills or update existing ones with specialized knowledge, workflows, or tool integrations. | custom, based on [anthropics/skills](https://github.com/anthropics/skills/) |
| `summarize` | Extract and summarize content from web pages, YouTube videos, and local files. No API keys required - uses direct content extraction. | custom, based on [steipete/summarize](https://github.com/steipete/summarize) |
| `write-a-prd` | Create a numbered PRD (`PRD #N`) through user interview, codebase exploration, and module design. Saves as a tagged todo and offers handoff to `prd-to-todos`. Part of the [PRD Workflow](docs/prd-workflow.md). | custom, based on [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/write-a-prd) |
