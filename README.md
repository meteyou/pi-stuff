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

You can easily install this package directly using the `pi` command line interface. This will make all contained skills,
themes, and extensions immediately available to your agent.

### Standard Installation

Run the following command to install the package from GitHub:

```bash
pi install https://github.com/meteyou/pi-stuff.git
```

Once installed, `pi` will automatically detect the new capabilities. You can start using the skills immediately in your
next session.

## Extensions

| Extension | Description | Command |
|-----------|-------------|---------|
| `context-usage` | Displays a visual representation of context window usage similar to Claude Code. Shows breakdown by System Prompt, Messages, and Files. | `/context` |
| `quota-antigravity` | Displays the current quota usage for Antigravity models, including remaining prompt credits and model-specific limits. | `/quota-antigravity` |
| `quota-claude` | Displays Claude Pro/Max subscription usage (5-hour and 7-day limits) in the footer. Only visible when using Anthropic models. | `/quota-claude` |
| `review` | Flexible code-review workflow (uncommitted/branch/commit/PR/folder/custom) with optional fresh review branch and `/end-review`. Based on ideas from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/). | `/review`, `/end-review` |

## Skills

| Skill | Description | Source |
|-------|-------------|--------|
| `github` | Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `improve-skill` | Analyze coding agent session transcripts to improve existing skills or create new ones. Use when asked to improve a skill based on a session, or extract a new skill from session history. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `pi-share` | Load and parse session transcripts from shittycodingagent.ai/buildwithpi.ai/buildwithpi.com (pi-share) URLs. Fetches gists, decodes embedded session data, and extracts conversation history. | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/) |
| `skill-creator` | Guide for creating effective skills. Use to create new skills or update existing ones with specialized knowledge, workflows, or tool integrations. | [anthropics/skills](https://github.com/anthropics/skills/) |
| `summarize` | Extract and summarize content from web pages, YouTube videos, and local files. No API keys required - uses direct content extraction. Based on [steipete/summarize](https://github.com/steipete/summarize). | custom |
