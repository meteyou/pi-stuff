# Quota Claude Extension

Monitor your Claude Pro/Max subscription usage directly in Pi.

## Concept

This extension helps you track your Claude subscription limits:
1. **Monitor** - See 5-hour and 7-day usage at a glance
2. **Track** - Footer status shows current usage while coding
3. **Plan** - Know when limits reset to manage your usage

## Requirements

- **Claude Pro or Max subscription** via Anthropic
- **OAuth login** - Use `/login` in Pi and select "Claude Pro/Max"

The extension reads credentials from Pi's auth file (`~/.pi/agent/auth.json`), so no additional setup is needed.

## Commands

| Command | Description |
|---------|-------------|
| `/quota-claude` | Display detailed usage with visual progress bars |

## Footer Status

When using an Anthropic model, the extension automatically displays usage in the footer:

```
Claude: 5h: 17% (4h 12m) │ 7d: 84% (Wed at 7:00pm)
```

Status indicators:
- **Green** - Less than 70% used
- **Yellow** - 70-90% used
- **Red** - More than 90% used

The status:
- Updates automatically every 5 minutes
- Updates after each turn (with 2s delay for API sync)
- Only shows when using an Anthropic model
- Hides automatically when switching to other providers

## Detailed View

Running `/quota-claude` shows a detailed dashboard:

```
Current session
████████▌░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 17% used
Resets in 4h 12m

Current week (all models)
██████████████████████████████████████████░░░░░░░░ 84% used
Resets Wed at 7:00pm (Europe/Vienna)
```

### Progress Bar

| Symbol | Meaning |
|--------|---------|
| `█` | Used quota (colored by usage level) |
| `░` | Remaining quota (dim background) |

### Additional Sections

If you have separate Opus or Sonnet limits, they appear as additional sections:

```
Opus (7 days)
████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 40% used
Resets Wed at 7:00pm (Europe/Vienna)
```

## How It Works

### Authentication

The extension uses Pi's OAuth credentials:
1. You login via `/login` → "Claude Pro/Max"
2. Pi stores the OAuth token in `~/.pi/agent/auth.json`
3. The extension reads this token to query the usage API

### Polling

- **Footer status**: Updates every 5 minutes + after each turn
- **Command**: Always fetches fresh data

## Troubleshooting

### "Claude OAuth not found (use /login)"
- Run `/login` and select "Claude Pro/Max"
- Complete the OAuth flow in your browser

### "Failed to fetch usage"
- Your OAuth token may have expired - try `/login` again
- Check your internet connection

### Status not showing in footer
- Verify you're using an Anthropic model (`/model`)
- The status only appears for provider `anthropic`

### Usage not updating after turns
- There's a 2-second delay to allow the API to sync
- Try `/quota-claude` for immediate refresh

## Credits

Based on:
- [codelynx.dev guide](https://codelynx.dev/posts/claude-code-usage-limits-statusline) for API discovery
- [pi-mono anthropic.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/anthropic.ts) for auth logic
