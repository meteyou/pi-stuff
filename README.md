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

| Extension | Description | Command |
|-----------|-------------|---------|
| `answer` | Extracts open questions from the last assistant message and opens an interactive Q&A flow to submit structured answers. Based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/answer.ts). | `/answer` (+ `Ctrl+.`) |
| `context-usage` | Displays a visual representation of context window usage similar to Claude Code. Shows breakdown by System Prompt, Messages, and Files. | `/context` |
| `quota-antigravity` | Displays the current quota usage for Antigravity models, including remaining prompt credits and model-specific limits. | `/quota-antigravity` |
| `quota-claude` | Displays Claude Pro/Max subscription usage (5-hour and 7-day limits) in the footer. Only visible when using Anthropic models. | `/quota-claude` |
| `quota-codex` | Displays ChatGPT Plus/Pro (OpenAI Codex) usage windows in the footer when using provider `openai-codex`. | `/quota-openai` (alias: `/quota-codex`) |
| `review` | Flexible code-review workflow (uncommitted/branch/commit/PR/folder/custom) with optional fresh review branch and `/end-review`. Based on ideas from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/). | `/review`, `/end-review` |
| `session-breakdown` | Interactive breakdown of the last 7/30/90 days of Pi session usage (sessions/messages/tokens/cost) with heatmap and model table. Based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/session-breakdown.ts). | `/session-breakdown` |

## Skills

| Skill | Description | Source |
|-------|-------------|--------|
| `github` | Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `grill-me` | Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. | [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/grill-me) |
| `improve-skill` | Analyze coding agent session transcripts to improve existing skills or create new ones. Use when asked to improve a skill based on a session, or extract a new skill from session history. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `pi-share` | Load and parse session transcripts from shittycodingagent.ai/buildwithpi.ai/buildwithpi.com (pi-share) URLs. Fetches gists, decodes embedded session data, and extracts conversation history. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `prd-to-todos` | Break a PRD into independently-grabbable todos using tracer-bullet vertical slices. Adapted from `prd-to-issues`: uses local todos instead of GitHub Issues, removed HITL/AFK distinction (solo workflow). | [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/prd-to-issues) |
| `skill-creator` | Guide for creating effective skills. Use to create new skills or update existing ones with specialized knowledge, workflows, or tool integrations. | [anthropics/skills](https://github.com/anthropics/skills/) |
| `summarize` | Extract and summarize content from web pages, YouTube videos, and local files. No API keys required - uses direct content extraction. Based on [steipete/summarize](https://github.com/steipete/summarize). | custom |
| `write-a-prd` | Create a PRD through user interview, codebase exploration, and module design. Adapted from original: saves PRD as a local todo (tagged `prd`) instead of a GitHub Issue. | [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/write-a-prd) |
