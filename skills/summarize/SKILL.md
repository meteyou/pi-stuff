---
name: summarize
description: Summarize web articles, blog posts, or YouTube videos when the user explicitly asks for a summary. Use ONLY when the user says "summarize", "give me a summary", "what is this article/video about", or similar. Do NOT use this skill for fetching raw file content, downloading code, reading GitHub repos/files/issues/PRs, or any task that doesn't involve summarization.
---

# Summarize

Extract readable content from web articles and YouTube video transcripts, then summarize them. No external API keys needed - content is extracted directly and summarized by the current LLM.

## When to use this skill

- User explicitly asks to **summarize** a web page, article, blog post, or YouTube video
- User asks "what is this article/video about?"

## When NOT to use this skill

- Fetching raw content from GitHub (repos, files, issues, PRs, raw URLs) → use `gh` CLI or `curl` instead
- Downloading or reading source code files from URLs → use `curl` instead
- Reading documentation to follow instructions → use `curl` instead
- Any task where the user does NOT ask for a summary

## Scripts

### Web Page Extraction

Extract readable text from any web page:

```bash
python3 scripts/extract_webpage.py <url> [--format text|md|json] [--max-chars N] [--timeout N]
```

- `--format json` returns structured output with title, description, content, and character count
- `--max-chars N` clips output at sentence boundary
- Strips scripts, styles, hidden elements, nav, footer
- Extracts text from `<p>`, `<h1-6>`, `<li>`, `<blockquote>`, `<pre>`, `<td>` tags
- Note: does not execute JavaScript - JS-rendered SPAs may return limited content

### YouTube Transcript Extraction

Extract transcript from YouTube videos (no API key needed):

```bash
python3 scripts/extract_youtube_transcript.py <youtube_url> [--timestamps] [--json]
```

- `--timestamps` prefixes each line with `[mm:ss]`
- `--json` outputs structured data with segments, timing, video metadata
- Tries 3 methods in order: youtubei endpoint → caption tracks → ANDROID player API
- Supports `youtube.com/watch`, `youtu.be`, `/shorts/`, `/live/`, `/embed/` URLs

## Workflow

1. **Extract content** using the appropriate script
2. **Summarize** the extracted content directly (you are the LLM - no external API needed)

For web pages:
```bash
python3 scripts/extract_webpage.py "https://example.com" --format json
```

For YouTube:
```bash
python3 scripts/extract_youtube_transcript.py "https://youtu.be/VIDEO_ID" --timestamps
```

## Guidelines

- Use `--max-chars` for very long pages to keep context manageable (e.g. `--max-chars 20000`)
- Use `--format json` when you need title/metadata alongside content
- For YouTube, prefer `--timestamps` when the user wants time references
- When summarizing, match the output language to the source language unless the user requests otherwise
- For JS-heavy SPAs, mention that content may be incomplete and suggest the user try a different approach
