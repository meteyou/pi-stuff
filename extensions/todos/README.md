# Todos Extension

File-based todo manager with claiming, locking, and garbage collection. Fork of [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/todos.ts) with a fix for the `getEditorKeybindings` ESM/CJS interop issue.

## Changes from Upstream

- Removed dependency on `getEditorKeybindings()` from `@mariozechner/pi-tui` (caused `TypeError: is not a function` due to ESM/CJS interop when the extension resolves an older peer dependency version)
- Replaced with a local `matchesAction()` helper that uses `matchesKey()` and `Key.*` constants directly

## Concept

Todos are stored as standalone markdown files in `.pi/todos/` (or `PI_TODO_PATH`). Each file has a JSON front matter block followed by an optional markdown body. The extension provides both a visual TUI and an LLM-accessible `todo` tool.

## Commands

| Command | Description |
|---------|-------------|
| `/todos [search]` | Open the visual todo manager with optional search filter |

## Tool

The `todo` tool is available to the LLM with these actions:

| Action | Description |
|--------|-------------|
| `list` | List open and assigned todos |
| `list-all` | List all todos including closed |
| `get` | Get a specific todo by id |
| `create` | Create a new todo |
| `update` | Update a todo (replaces body) |
| `append` | Append to a todo's body |
| `delete` | Delete a todo |
| `claim` | Assign a todo to the current session |
| `release` | Release a todo assignment |

## Interactive Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate todos |
| `Enter` | Open action menu |
| `Ctrl+Shift+W` | Quick-work on selected todo |
| `Ctrl+Shift+R` | Quick-refine selected todo |
| `Esc` | Close |

## File Format

```
{
  "id": "deadbeef",
  "title": "Add tests",
  "tags": ["qa"],
  "status": "open",
  "created_at": "2026-01-25T17:00:00.000Z",
  "assigned_to_session": "session.json"
}

Notes about the work go here.
```

## Settings

Stored in `.pi/todos/settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `gc` | `true` | Auto-delete closed todos older than `gcDays` |
| `gcDays` | `7` | Age threshold for garbage collection (days) |
