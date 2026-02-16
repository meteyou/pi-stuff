#!/usr/bin/env python3
"""Extract readable content from a web page URL.

Strips scripts/styles/hidden elements and extracts article text
using regex-based tag stripping + segment extraction.

Usage: python3 extract_webpage.py <url> [--format text|md|json] [--max-chars N]

Output: Clean text content to stdout.
"""

import argparse
import json
import re
import ssl
import sys
import urllib.request
from html import unescape

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
}


def _ssl_ctx():
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except ImportError:
        pass
    return ctx


def fetch_html(url: str, timeout: int = 10) -> tuple[str, str]:
    """Fetch HTML and return (html, final_url)."""
    req = urllib.request.Request(url, headers=REQUEST_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx()) as resp:
        final_url = resp.url or url
        charset = resp.headers.get_content_charset() or "utf-8"
        html = resp.read().decode(charset, errors="replace")
    return html, final_url


def extract_metadata(html: str) -> dict:
    """Extract title and description from HTML."""
    title = None
    description = None

    # Title from <title> tag
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
    if m:
        title = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()

    # og:title
    m = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']', html, re.IGNORECASE)
    if m:
        title = unescape(m.group(1)).strip()

    # description
    for attr in ("og:description", "description", "twitter:description"):
        pat1 = rf'<meta[^>]+(?:property|name)=["\']{ re.escape(attr) }["\'][^>]+content=["\']([^"\']+)["\']'
        pat2 = rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']{ re.escape(attr) }["\']'
        m = re.search(pat1, html, re.IGNORECASE) or re.search(pat2, html, re.IGNORECASE)
        if m:
            description = unescape(m.group(1)).strip()
            break

    return {"title": title, "description": description}


def strip_tags_and_content(html: str, tags: list[str]) -> str:
    """Remove specified tags and their content entirely."""
    for tag in tags:
        html = re.sub(
            rf"<{tag}\b[^>]*>[\s\S]*?</{tag}>",
            "",
            html,
            flags=re.IGNORECASE,
        )
        # Self-closing
        html = re.sub(rf"<{tag}\b[^>]*/?>", "", html, flags=re.IGNORECASE)
    return html


def strip_hidden_elements(html: str) -> str:
    """Remove elements with hidden styles or attributes."""
    # Remove aria-hidden="true"
    html = re.sub(r'<[^>]+aria-hidden\s*=\s*["\']true["\'][^>]*>[\s\S]*?</[^>]+>', "", html, flags=re.IGNORECASE)
    # Remove display:none
    html = re.sub(r'<[^>]+style\s*=\s*["\'][^"\']*display\s*:\s*none[^"\']*["\'][^>]*>[\s\S]*?</[^>]+>', "", html, flags=re.IGNORECASE)
    # Remove hidden attribute
    html = re.sub(r"<[^>]+\bhidden\b[^>]*>[\s\S]*?</[^>]+>", "", html, flags=re.IGNORECASE)
    return html


def extract_segments(html: str) -> list[str]:
    """Extract text segments from content tags."""
    segments = []

    # Remove non-content tags
    html = strip_tags_and_content(html, [
        "script", "style", "noscript", "template", "svg", "canvas",
        "iframe", "object", "embed", "nav", "footer",
    ])
    html = strip_hidden_elements(html)
    # Remove HTML comments
    html = re.sub(r"<!--[\s\S]*?-->", "", html)

    # Extract from content tags
    content_pattern = re.compile(
        r"<(p|h[1-6]|li|blockquote|pre|td|figcaption)\b[^>]*>([\s\S]*?)</\1>",
        re.IGNORECASE,
    )

    for m in content_pattern.finditer(html):
        tag = m.group(1).lower()
        inner = m.group(2)

        # Strip all HTML tags from inner content
        text = re.sub(r"<[^>]+>", "", inner)
        text = unescape(text)
        # Normalize whitespace
        text = re.sub(r"\s+", " ", text).strip()

        if not text:
            continue

        if tag.startswith("h") and len(tag) == 2:
            if len(text) >= 10:
                level = tag[1]
                segments.append(f"{'#' * int(level)} {text}")
        elif tag == "li":
            if len(text) >= 20:
                segments.append(f"• {text}")
        elif len(text) >= 30:
            segments.append(text)

    return segments


def normalize_text(text: str) -> str:
    """Normalize whitespace and invisible chars."""
    text = re.sub(r"[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]", "", text)
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[\t ]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def clip_at_sentence(text: str, max_chars: int) -> str:
    """Clip text at a sentence boundary."""
    if len(text) <= max_chars:
        return text
    clip = text[:max_chars]
    last_break = max(clip.rfind(". "), clip.rfind("! "), clip.rfind("? "), clip.rfind("\n\n"))
    if last_break > max_chars * 0.5:
        return clip[:last_break + 1]
    return clip


def main():
    ap = argparse.ArgumentParser(description="Extract readable content from a web page")
    ap.add_argument("url", help="URL to extract content from")
    ap.add_argument("--format", choices=["text", "md", "json"], default="text",
                    help="Output format (default: text)")
    ap.add_argument("--max-chars", type=int, default=0,
                    help="Maximum characters (0 = unlimited)")
    ap.add_argument("--timeout", type=int, default=10,
                    help="HTTP timeout in seconds (default: 10)")
    args = ap.parse_args()

    try:
        html, final_url = fetch_html(args.url, timeout=args.timeout)
    except Exception as e:
        print(f"Error fetching {args.url}: {e}", file=sys.stderr)
        sys.exit(1)

    metadata = extract_metadata(html)
    segments = extract_segments(html)
    content = normalize_text("\n".join(segments))

    if args.max_chars > 0:
        content = clip_at_sentence(content, args.max_chars)

    if args.format == "json":
        result = {
            "url": final_url,
            "title": metadata.get("title"),
            "description": metadata.get("description"),
            "content": content,
            "characters": len(content),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if metadata.get("title"):
            print(f"# {metadata['title']}\n")
        if metadata.get("description") and args.format == "md":
            print(f"> {metadata['description']}\n")
        print(content)


if __name__ == "__main__":
    main()
