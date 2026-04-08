# Claude Code Version Override

Overrides Pi's Anthropic `user-agent` header to advertise a newer Claude Code CLI version without patching `@mariozechner/pi-ai` in `node_modules`.

## What it does

- keeps the built-in Anthropic provider and models
- re-registers provider `anthropic` with the same base URL
- overrides `user-agent` to `claude-cli/2.1.94`

## Why this exists

`pi.registerProvider()` can override provider headers at runtime, which is enough for this use case and avoids maintaining a local patch against `pi-ai`.
