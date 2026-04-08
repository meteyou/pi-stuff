# cc-support

Makes Pi appear as Claude Code to the Anthropic API.

## What it does

1. **Version override** – Re-registers provider `anthropic` with `user-agent: claude-cli/2.1.94`
2. **System prompt rewrite** – Replaces all occurrences of "pi" with "claude code" in the system prompt before the agent starts

## Sources

- Version override based on a previous local extension
- System prompt rewrite based on [Sukitly/pi-extensions](https://github.com/Sukitly/pi-extensions)
