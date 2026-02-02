# Context Usage Extension

A visual context window monitor for Pi, similar to Claude Code's context display.

## Concept

This extension helps you understand how your context window is being used:
1. **Visualize** - See a grid representation of context window usage
2. **Track** - Monitor files read and skills loaded during your session

## Commands

| Command | Description |
|---------|-------------|
| `/context` | Display detailed context window usage with visual grid |

## Visual Elements

The extension uses special symbols to represent context usage:

| Symbol | Meaning |
|--------|---------|
| `⛁` | Used tokens (filled) |
| `⛶` | Free space (empty) |
| `⛝` | Reserved for compaction |

## Output Breakdown

When you run `/context`, you'll see:

### 1. Visual Grid (10×10)
A grid showing proportional usage with color-coded cells:
- **Dim** - System Prompt tokens
- **Green** - Message tokens
- **Muted** - Compaction reserve

### 2. Token Breakdown Tree
```
⛁ System Prompt: 45.2k tokens (22.6%)
    ├ SYSTEM.md: 38.1k tokens
    ├ Tools: 5.2k tokens
    ├ Skills: 1.5k tokens
    └ AGENTS.md: 0.4k tokens

⛁ Messages: 12.3k tokens (6.2%)
    ├ Loaded skills: 2.1k tokens
    └ Context: 10.2k tokens

⛶ Free space: 138.5k (69.3%)
⛝ Compaction reserve: 4.0k tokens
```

### 3. Additional Sections
- **AGENTS.md / CLAUDE.md** - Lists all agent instruction files found
- **Loaded Skills** - Skills loaded via `/skill:name` in this session
- **Read Files** - Files read via the `read` tool, sorted by size

## What Gets Tracked

### System Prompt Components
- Base system prompt (SYSTEM.md)
- Registered tools and their schemas
- Available skills directory (`<available_skills>` block)
- AGENTS.md / CLAUDE.md files (searched from cwd to root)

### Session Activity
- **Read files** - Tracked when the `read` tool is used
- **Loaded skills** - Tracked when `/skill:name` commands are used

## Example Session

```bash
# Check current context usage
/context

# The visual display shows:
# - How much of your context window is used
# - Breakdown by system prompt vs messages
# - All files you've read this session
# - Any skills you've loaded
```

## Technical Details

### Token Estimation
Tokens are estimated using Pi's standard heuristic: **4 characters = 1 token**

### Compaction Reserve
The extension reads your configured `compactionReserveTokens` setting to show how much space is reserved for automatic compaction.

### File Discovery
AGENTS.md and CLAUDE.md files are discovered by walking up the directory tree from your current working directory, plus checking `.pi/AGENTS.md`.

## Tips

### 1. Monitor Large Sessions
Use `/context` when working on complex tasks to see if you're approaching context limits.

### 2. Identify Token-Heavy Files
The "Read Files" section shows which files are consuming the most context, sorted by size.

### 3. Plan for Compaction
The reserved space shown helps you understand when automatic compaction might trigger.
