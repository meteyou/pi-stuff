---
name: summarize
description: Extract and summarize content from web pages, YouTube videos, and local files. Use when asked to summarize a URL, article, blog post, or YouTube video. Also use for extracting readable text from web pages, fetching YouTube transcripts, or reading online documentation/articles. No API keys required - uses direct content extraction.
---

# Summarize

Extract readable content from web pages and YouTube video transcripts using Python scripts. No external API keys needed - content is extracted directly and can be summarized by the current LLM.

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
