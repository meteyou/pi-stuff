# Review Extension

Code review extension that prompts the agent to review code changes. Fork of [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/review.ts) with compatibility fixes for the current `@mariozechner/pi-tui` API.

## Why this fork?

The upstream `mitsupi` package uses the deprecated `getEditorKeybindings()` function and old keybinding names (`selectUp`, `selectDown`, etc.) which were renamed in recent `pi-tui` versions:

| Old (broken) | New (fixed) |
|---|---|
| `getEditorKeybindings()` | `getKeybindings()` |
| `"selectUp"` | `"tui.select.up"` |
| `"selectDown"` | `"tui.select.down"` |
| `"selectConfirm"` | `"tui.select.confirm"` |
| `"selectCancel"` | `"tui.select.cancel"` |

Without this fix, using arrow keys in the branch selector crashes with:
```
TypeError: (0 , _piTui.getEditorKeybindings) is not a function
```

## Commands

| Command | Description |
|---|---|
| `/review` | Show interactive review mode selector |
| `/review pr 123` | Review PR #123 (checks out locally) |
| `/review pr <url>` | Review PR from GitHub URL |
| `/review uncommitted` | Review uncommitted changes |
| `/review branch <name>` | Review against a base branch |
| `/review commit <hash>` | Review a specific commit |
| `/review folder <paths>` | Review specific folders/files (snapshot) |
| `/review custom "<instructions>"` | Custom review instructions |

## Review Guidelines

If a `REVIEW_GUIDELINES.md` file exists in the same directory as `.pi`, its contents are automatically appended to the review prompt.
