# Review Extension

A flexible code review workflow for Pi, inspired by Codex's review feature and copied from
[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/review.ts).

## Concept

This extension helps you run structured reviews directly inside Pi:
1. **Select scope** - Review uncommitted changes, branch diff, commit, PR, folders, or custom instructions
2. **Stay focused** - Uses a built-in review rubric with priorities (P0-P3)
3. **Control workflow** - Optionally start in a fresh session branch and return with `/end-review`

## Commands

| Command                        | Description                                                      |
|--------------------------------|------------------------------------------------------------------|
| `/review`                      | Open interactive review preset selector                          |
| `/review uncommitted`          | Review staged/unstaged/untracked changes                         |
| `/review branch <name>`        | Review changes against a base branch                             |
| `/review commit <sha> [title]` | Review a specific commit                                         |
| `/review pr <number-or-url>`   | Review a GitHub PR (checks out PR locally)                       |
| `/review folder <path...>`     | Snapshot review of one or more files/folders (not diff-based)    |
| `/review custom "..."`         | Run review with custom instructions                              |
| `/end-review`                  | End fresh-session review and return to original session position |

## Review Modes

1. **Uncommitted:** Reviews current local working tree changes.
2. **Base Branch:** Computes merge-base against the chosen base branch and reviews the resulting diff.
3. **Commit:** Reviews only the changes introduced by one commit.
4. **Pull Request:** Fetches metadata via `gh pr view`, checks out the PR via `gh pr checkout`, then reviews against PR base branch.
5. **Folder:** Runs a snapshot review over selected paths by reading files directly (no git diff).
6. **Custom:** Lets you define your own review focus/instructions.

## Interactive Workflow

Running `/review` opens a preset selector with smart default behavior:
- If uncommitted changes exist → defaults to **uncommitted**
- Else if on a non-default branch → defaults to **base branch**
- Else → defaults to **commit**

For existing sessions, you can choose:
- **Empty branch** - starts review in a fresh branch in the session tree
- **Current session** - keeps review in current conversation

When a fresh review branch is active, a footer widget shows:
- `Review session active, return with /end-review`

## Ending a Review

Use `/end-review` to return from fresh review branches.

You can choose:
- **Summarize** - creates a structured review summary while navigating back
- **No summary** - returns directly

The summary prompt captures:
- reviewed scope
- findings with priorities
- overall verdict
- recommended next steps

## Project-Specific Review Guidelines

If a `REVIEW_GUIDELINES.md` exists in the project root (same directory that contains `.pi`), its contents are appended to the review prompt automatically.

This allows repository-specific rules to override or refine the default rubric.

## Requirements

- Git repository (required)
- Interactive UI mode (required)
- For PR review:
  - GitHub CLI (`gh`) installed and authenticated
  - Clean tracked working tree (no staged/unstaged tracked changes)

## Example Usage

```bash
# Open selector
/review

# Review local changes
/review uncommitted

# Review branch diff
/review branch main

# Review a commit
/review commit abc1234

# Review GitHub PR
/review pr 123
/review pr https://github.com/owner/repo/pull/123

# Snapshot review for specific paths
/review folder src docs README.md

# Custom review focus
/review custom "check for security and error handling issues"

# Return from fresh review branch
/end-review
```

## Output Style

The extension enforces a structured review style:
- prioritize actionable findings
- include severity tags `[P0]` to `[P3]`
- reference concrete file/line locations
- provide an overall verdict: `correct` or `needs attention`
- ignore trivial style-only issues unless they affect clarity/standards
