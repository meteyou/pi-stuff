# Review Extension

Code review extension that prompts the agent to review code changes. Fork of [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/review.ts) with compatibility fixes for the current `@earendil-works/pi-tui` API.

## Why this fork?

The upstream `mitsuhiko` package uses the deprecated `getEditorKeybindings()` function and old keybinding names (`selectUp`, `selectDown`, etc.) which were renamed in recent `pi-tui` versions:

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
| `/review pr 123` | Review PR #123 (GitHub) / MR !123 (GitLab) - provider detected from the git remote, checked out locally |
| `/review pr <url>` | Review PR from a GitHub URL or MR from a GitLab URL |
| `/review mr 123` | Alias for `/review pr` (GitLab-style) |
| `/review uncommitted` | Review uncommitted changes |
| `/review branch <name>` | Review against a base branch |
| `/review commit <hash>` | Review a specific commit |
| `/review folder <paths>` | Review specific folders/files (snapshot) |
| `/review custom "<instructions>"` | Custom review instructions |

## Review Guidelines

If a `REVIEW_GUIDELINES.md` file exists in the same directory as `.pi`, its contents are automatically appended to the review prompt.

## Shared review prompts

The review rubric lives in [`review-prompts.ts`](./review-prompts.ts) (not an `index.ts`, so pi does not load it as an extension) and is shared with `prd-loop-pro`:

| Export | Purpose |
|---|---|
| `REVIEW_RUBRIC_CORE` | Format-agnostic rubric: what to flag, untrusted input, comment guidelines, review priorities, fail-fast rules, priority levels P0–P3 |
| `REVIEW_HUMAN_CALLOUTS_SECTION`, `REVIEW_MARKDOWN_OUTPUT_FORMAT` | Markdown output + required Human Reviewer Callouts section |
| `REVIEW_RUBRIC_MARKDOWN` | Full rubric used by `/review` |
| `REVIEW_JSON_OUTPUT_FORMAT`, `REVIEW_RUBRIC_JSON` | JSON output contract `{ verdict, summary, findings[], callouts[] }` (final message = raw JSON) used by `prd-loop-pro` |
| `UNCOMMITTED_PROMPT` | Focus prompt for uncommitted changes |
| `composeReviewPrompt`, `appendProjectReviewGuidelines` | Prompt composition helpers |
| `loadProjectReviewGuidelines` | `REVIEW_GUIDELINES.md` loader |

Run `npm test` to verify the markdown rubric stays byte-identical to the original.

## GitLab Support

GitLab merge requests are reviewed the same way as GitHub PRs:

- **Provider detection**: For bare numbers (e.g. `/review pr 123`), the provider is detected from the git remote *URLs* (`gitlab` vs `github`). URLs always imply their provider. If the remotes are ambiguous, the installed CLI is used as a hint.
- **MR metadata**: Requires the [`glab` CLI](https://gitlab.com/gitlab-org/cli) installed and authenticated (`glab auth login`). Used via `glab mr view <iid> --output json`.
- **Checkout**: Uses GitLab's merge-request refs directly, so it works for MRs from forks too:
  1. `git fetch origin +refs/merge-requests/<iid>/head:refs/remotes/origin/merge-requests/<iid>/head`
  2. `git fetch origin <base-branch>` (failure is surfaced as a warning; the merge base may then be missing or stale)
  3. `git checkout -B <head-branch> refs/remotes/origin/merge-requests/<iid>/head`

  The git remote must be named `origin`. Note: the `refs/remotes/origin/merge-requests/*` refs accumulate over time (one per reviewed MR). They are plain local refs and can be pruned manually, e.g. `git update-ref -d refs/remotes/origin/merge-requests/<iid>/head`.
