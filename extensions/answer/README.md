# Answer Extension

Extracts open questions from the last assistant message and guides you through answering them in an interactive TUI. Based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/answer.ts).

## Concept

This extension helps you quickly respond when the assistant asks multiple questions:
1. **Extract** - Detects answerable questions from the latest assistant response
2. **Collect** - Lets you answer each question in a focused, step-by-step UI
3. **Submit** - Sends a compiled answer message back into the session and triggers the next turn

## Commands

| Command | Description |
|---------|-------------|
| `/answer` | Extract questions from the last assistant message and open Q&A UI |

## Shortcut

| Shortcut | Description |
|----------|-------------|
| `Ctrl+.` | Run the same flow as `/answer` |

## Workflow

1. Reads the **last assistant message** from the current branch
2. Runs structured extraction (`{ questions: [...] }`) using an LLM
3. Opens an interactive Q&A screen
4. Sends a compiled message like:
   - `Q: ...`
   - `A: ...`
5. Automatically triggers a new assistant turn

## Extraction Model Selection

If the last message doesn't use the structured `Q:`/`A:` format, questions are extracted by an LLM.
A cheap model from the **same provider** as the current model is used (reuses the active subscription/API key):

| Provider | Extraction model |
|----------|------------------|
| `anthropic` | `claude-haiku-5-5` |
| `openai` | `gpt-6-luna` |
| `openai-codex` | `gpt-6-luna` |

Fallbacks:
- Provider not listed, model unknown, or no auth configured → current active model is used.
- Request with the cheap model fails (API error, no access, unparsable response) → retried once with the current active model.
- If both fail, an error notification with the reason is shown.

## Interactive Controls

| Key | Action |
|-----|--------|
| `Tab` / `Enter` | Next question |
| `Shift+Tab` | Previous question |
| `Shift+Enter` | Insert newline in answer |
| `Esc` / `Ctrl+C` | Cancel |
| `y` / `Enter` (confirm dialog) | Submit all answers |
| `n` / `Esc` (confirm dialog) | Return to editing |

## Requirements

- Interactive UI mode required
- A selected model required
- At least one completed assistant message in current branch

## Notes

- If no questions are found, the extension exits with an info notification.
- If the last assistant message is incomplete (`stopReason !== "stop"`), extraction is aborted to avoid answering partial output.