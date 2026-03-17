# Quota Codex Extension

Monitor your ChatGPT Plus/Pro (OpenAI Codex) usage directly in Pi.

## Concept

This extension helps you track Codex limits:
1. **Monitor** - See current and long-window usage at a glance
2. **Track** - Footer status shows quota usage while coding
3. **Plan** - Know when limits reset

## Requirements

- **ChatGPT Plus or Pro** subscription
- **OAuth login** - Use `/login` in Pi and select "ChatGPT Plus/Pro (Codex)"

The extension reads credentials from Pi's auth file (`~/.pi/agent/auth.json`), so no additional setup is needed.

## Commands

| Command | Description |
|---------|-------------|
| `/quota-openai` | Display detailed Codex usage with visual progress bars |
| `/quota-codex` | Alias for `/quota-openai` |

## Footer Status

When using an OpenAI Codex model, the extension displays usage in the footer:

```
Codex: 5h: 21% (2h 35m) │ 7d: 37% (5d 16h)
```

Status indicators:
- **Green** - Less than 70% used
- **Yellow** - 70-90% used
- **Red** - More than 90% used

The status:
- Updates every 5 minutes
- Updates after each Codex turn (with 2s delay)
- Only shows for provider `openai-codex`

## Detailed View

Running `/quota-openai` shows details like:

```
Plan: Plus

Current window (5h)
██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 21% used
Resets in 2h 35m

Long window (7d)
██████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 37% used
Resets Sun at 8:00pm (Europe/Vienna)
```

If available, additional sections are shown for:
- Code review usage windows
- Credit balance information

## Troubleshooting

### "Codex OAuth not found (use /login)"
- Run `/login` and choose "ChatGPT Plus/Pro (Codex)"
- Complete OAuth flow in your browser

### "Failed to fetch usage"
- Try `/login` again (token may be expired)
- Check internet connection

### Status not showing in footer
- Verify your selected model provider is `openai-codex` (`/model`)
- The extension only appears while using Codex subscription models

## Technical Notes

The extension fetches usage from:
- `https://chatgpt.com/backend-api/wham/usage`

using OAuth credentials from Pi auth (`access` token + `accountId`).
