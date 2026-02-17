# Session Breakdown Extension

Interactive usage analytics for Pi sessions based on `~/.pi/agent/sessions` (`*.jsonl`), based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/session-breakdown.ts).

## Concept

This extension helps you understand recent activity across your Pi sessions:
1. **Analyze** - Scans the last 90 days of session files
2. **Visualize** - Shows a GitHub-contributions-style heatmap
3. **Break down** - Aggregates usage by model (sessions/messages/tokens/cost)

## Commands

| Command | Description |
|---------|-------------|
| `/session-breakdown` | Open interactive breakdown for 7/30/90 days |

## Interactive View

The dashboard includes:

### 1. Range & Metric Tabs
- **Ranges**: `7d`, `30d`, `90d`
- **Metrics**: `sess`, `msg`, `tok`

The graph automatically falls back when data is missing:
- `tokens` → falls back to `messages` if no token usage is available
- `messages` → falls back to `sessions` if no message data is available

### 2. Heatmap Graph
A calendar-like grid (weeks × weekdays):
- **Brightness** = activity intensity (log-scaled per selected metric)
- **Color hue** = weighted mix of active model colors for that day
- **Empty days** = dark muted cells

### 3. Summary Line
Shows totals for the selected range:
- sessions
- selected metric volume (messages/tokens when available)
- total cost and average cost per session

### 4. Model Legend + Table
- Color legend uses top models from the **last 30 days**
- Model table shows per-model:
  - selected metric count
  - cost
  - share of total

## Keyboard Controls

| Key | Action |
|-----|--------|
| `←` / `→` or `h` / `l` | Switch range (7/30/90) |
| `1` / `2` / `3` | Jump directly to 7d / 30d / 90d |
| `Tab` / `Shift+Tab` or `t` | Cycle metric (sessions/messages/tokens) |
| `q`, `Esc`, `Ctrl+C` | Close |

## Data Sources

The extension reads session logs recursively from:

```text
~/.pi/agent/sessions
```

It parses `message` and `model_change` events, then aggregates:
- sessions/day
- messages/day
- tokens/day (if usage data exists)
- cost/day (if usage data exists)
- per-model totals across the selected range

## Progress / Loading

Before the UI appears, analysis runs in phases:
1. **scan** - discover relevant `*.jsonl` files
2. **parse** - parse files and aggregate usage
3. **finalize** - build palette and final data structures

The loader can be cancelled while running.

## Non-interactive Behavior

If no UI is available, `/session-breakdown` returns a compact non-interactive summary (30-day session overview).