# cc-support

Makes Pi appear as Claude Code to the Anthropic API.

## What it does

1. **Version override** – Re-registers provider `anthropic` with `user-agent: claude-cli/<CLAUDE_CODE_VERSION>` (constant in `index.ts`); the base URL is left untouched
2. **System prompt rewrite** – Replaces all standalone occurrences of "pi" with "claude code" in the system prompt (leading system blocks and mid-conversation system messages) of every Anthropic request via `before_provider_request`. This also covers turns that don't start from a user prompt (e.g. `pi.sendMessage(..., { triggerTurn: true })` from `/answer`, retries, continuations), which `before_agent_start` would miss

## Sources

- Version override based on a previous local extension
- System prompt rewrite based on [Sukitly/pi-extensions](https://github.com/Sukitly/pi-extensions)
