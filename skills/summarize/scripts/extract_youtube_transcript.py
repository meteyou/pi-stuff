#!/usr/bin/env python3
"""Extract transcript from a YouTube video without API keys.

Uses the same approach as steipete/summarize:
1. Fetch the YouTube watch page HTML
2. Extract ytInitialPlayerResponse for caption track metadata
3. Try youtubei get_transcript endpoint (preferred)
4. Fall back to caption track URLs (json3 format, then XML)
5. Try ANDROID client player API as last resort

Usage: python3 extract_youtube_transcript.py <youtube_url> [--timestamps] [--json]

Output: Transcript text to stdout.
"""

import argparse
import json
import re
import sys
import urllib.request
import urllib.error
from html import unescape
from urllib.parse import urlparse, parse_qs, urlencode

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
}


def extract_video_id(url: str) -> str | None:
    """Extract YouTube video ID from various URL formats."""
    parsed = urlparse(url)
    host = parsed.hostname or ""

    if host == "youtu.be":
        path_parts = parsed.path.strip("/").split("/")
        return path_parts[0] if path_parts and path_parts[0] else None

    if "youtube.com" not in host:
        return None

    if parsed.path == "/watch":
        return parse_qs(parsed.query).get("v", [None])[0]

    for prefix in ("/shorts/", "/live/", "/embed/", "/v/"):
        if parsed.path.startswith(prefix):
            parts = parsed.path[len(prefix):].split("/")
            return parts[0] if parts else None

    return None


def _ssl_context():
    import ssl
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except ImportError:
        pass
    return ctx

def fetch_url(url: str, headers: dict = None, data: bytes = None, timeout: int = 10) -> str:
    """Fetch URL and return text content."""
    hdrs = dict(REQUEST_HEADERS)
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs, data=data)
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def fetch_json(url: str, payload: dict = None, extra_headers: dict = None, timeout: int = 10) -> dict | None:
    """POST JSON and return parsed response."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(payload).encode() if payload else None
    try:
        text = fetch_url(url, headers=headers, data=data, timeout=timeout)
        # Strip potential XSSI guard
        text = re.sub(r"^\)\]\}'[^\n]*\n?", "", text)
        return json.loads(text)
    except Exception:
        return None


def extract_balanced_json(source: str, start_at: int) -> str | None:
    """Extract a balanced JSON object from source starting near start_at."""
    start = source.find("{", start_at)
    if start < 0:
        return None

    depth = 0
    in_string = False
    escaping = False

    for i in range(start, len(source)):
        ch = source[i]
        if in_string:
            if escaping:
                escaping = False
                continue
            if ch == "\\":
                escaping = True
                continue
            if ch in ('"', "'"):
                in_string = False
            continue
        if ch in ('"', "'"):
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
    return None


def extract_initial_player_response(html: str) -> dict | None:
    """Extract ytInitialPlayerResponse from watch page HTML."""
    token = "ytInitialPlayerResponse"
    idx = html.find(token)
    if idx < 0:
        return None
    eq_idx = html.find("=", idx)
    if eq_idx < 0:
        return None
    obj_text = extract_balanced_json(html, eq_idx)
    if not obj_text:
        return None
    try:
        return json.loads(obj_text)
    except json.JSONDecodeError:
        return None


def extract_innertube_api_key(html: str) -> str | None:
    """Extract INNERTUBE_API_KEY from page HTML."""
    patterns = [
        r'"INNERTUBE_API_KEY":"([^"]+)"',
        r'INNERTUBE_API_KEY\\":\\"([^\\"]+)\\"',
    ]
    for pat in patterns:
        m = re.search(pat, html)
        if m:
            return m.group(1).strip()
    return None


def extract_bootstrap_config(html: str) -> dict | None:
    """Extract ytcfg bootstrap config."""
    m = re.search(r"ytcfg\.set\s*\(\s*\{", html)
    if not m:
        return None
    obj = extract_balanced_json(html, m.start())
    if not obj:
        # Try to find the { after the match
        brace_start = html.find("{", m.start())
        if brace_start >= 0:
            obj = extract_balanced_json(html, brace_start)
    if not obj:
        return None
    try:
        return json.loads(obj)
    except json.JSONDecodeError:
        return None


def extract_transcript_params(html: str) -> str | None:
    """Extract getTranscriptEndpoint params."""
    m = re.search(r'"getTranscriptEndpoint":\{"params":"([^"]+)"\}', html)
    return m.group(1) if m else None


def get_caption_tracks(player_response: dict) -> list[dict]:
    """Extract caption tracks from player response."""
    captions = player_response.get("captions", {})
    renderer = captions.get("playerCaptionsTracklistRenderer", {})
    tracks = renderer.get("captionTracks", [])

    # Sort: prefer manual over ASR, prefer English
    def sort_key(track):
        kind = track.get("kind", "")
        lang = track.get("languageCode", "")
        is_asr = 1 if kind == "asr" else 0
        is_en = 0 if lang.startswith("en") else 1
        return (is_asr, is_en)

    return sorted(tracks, key=sort_key)


def parse_json3_transcript(text: str) -> list[dict] | None:
    """Parse JSON3 caption format."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None

    events = data.get("events", [])
    if not events:
        return None

    segments = []
    for event in events:
        segs = event.get("segs")
        if not segs:
            continue
        text_parts = []
        for seg in segs:
            utf8 = seg.get("utf8", "")
            if utf8:
                text_parts.append(utf8)
        text = "".join(text_parts).strip()
        if not text:
            continue

        start_ms = event.get("tStartMs")
        duration_ms = event.get("dDurationMs")
        segment = {"text": re.sub(r"\s+", " ", text).strip()}
        if start_ms is not None:
            segment["start_ms"] = int(start_ms)
            if duration_ms is not None:
                segment["end_ms"] = int(start_ms) + int(duration_ms)
        segments.append(segment)

    return segments if segments else None


def parse_xml_transcript(xml: str) -> list[dict] | None:
    """Parse XML caption format."""
    pattern = re.compile(r"<text[^>]*>([\s\S]*?)</text>", re.IGNORECASE)
    start_pattern = re.compile(r'\bstart\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)
    dur_pattern = re.compile(r'\bdur\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)

    segments = []
    for match in pattern.finditer(xml):
        text = unescape(match.group(1)).strip()
        text = re.sub(r"\s+", " ", text)
        if not text:
            continue

        tag = match.group(0)
        segment = {"text": text}

        start_m = start_pattern.search(tag)
        if start_m:
            try:
                segment["start_ms"] = int(float(start_m.group(1)) * 1000)
            except ValueError:
                pass

        dur_m = dur_pattern.search(tag)
        if dur_m and "start_ms" in segment:
            try:
                segment["end_ms"] = segment["start_ms"] + int(float(dur_m.group(1)) * 1000)
            except ValueError:
                pass

        segments.append(segment)

    return segments if segments else None


def download_caption_track(base_url: str) -> list[dict] | None:
    """Download and parse a caption track."""
    # Try JSON3 format first
    try:
        parsed_url = urlparse(base_url)
        params = parse_qs(parsed_url.query)
        params["fmt"] = ["json3"]
        params["alt"] = ["json"]
        json3_url = f"{parsed_url.scheme}://{parsed_url.netloc}{parsed_url.path}?{urlencode(params, doseq=True)}"
        text = fetch_url(json3_url)
        result = parse_json3_transcript(text)
        if result:
            return result
    except Exception:
        pass

    # Fall back to XML
    try:
        xml_url = re.sub(r"&fmt=[^&]+", "", base_url)
        text = fetch_url(xml_url)
        result = parse_json3_transcript(text)
        if result:
            return result
        return parse_xml_transcript(text)
    except Exception:
        return None


def try_youtubei_transcript(html: str, url: str) -> list[dict] | None:
    """Try the youtubei get_transcript endpoint."""
    config = extract_bootstrap_config(html)
    if not config:
        return None

    api_key = config.get("INNERTUBE_API_KEY")
    context = config.get("INNERTUBE_CONTEXT")
    params = extract_transcript_params(html)

    if not (api_key and context and params):
        return None

    # Add originalUrl to client context
    if "client" in context:
        context["client"]["originalUrl"] = url

    payload = {"context": context, "params": params}
    headers = {
        "Origin": "https://www.youtube.com",
        "Referer": url,
        "X-Goog-AuthUser": "0",
        "X-Youtube-Bootstrap-Logged-In": "false",
    }

    client_version = config.get("INNERTUBE_CLIENT_VERSION")
    if client_version:
        headers["X-Youtube-Client-Version"] = str(client_version)
    visitor_data = config.get("VISITOR_DATA")
    if visitor_data:
        headers["X-Goog-Visitor-Id"] = visitor_data

    data = fetch_json(
        f"https://www.youtube.com/youtubei/v1/get_transcript?key={api_key}",
        payload=payload,
        extra_headers=headers,
    )
    if not data:
        return None

    return parse_youtubei_response(data)


def parse_youtubei_response(data: dict) -> list[dict] | None:
    """Parse the youtubei get_transcript response."""
    try:
        actions = data.get("actions", [])
        if not actions:
            return None

        panel = actions[0].get("updateEngagementPanelAction", {})
        content = panel.get("content", {})
        renderer = content.get("transcriptRenderer", {})
        body_content = renderer.get("content", {})
        search_panel = body_content.get("transcriptSearchPanelRenderer", {})
        body = search_panel.get("body", {})
        segment_list = body.get("transcriptSegmentListRenderer", {})
        initial_segments = segment_list.get("initialSegments", [])

        if not initial_segments:
            return None

        segments = []
        for seg in initial_segments:
            seg_renderer = seg.get("transcriptSegmentRenderer", {})
            snippet = seg_renderer.get("snippet", {})
            runs = snippet.get("runs", [])
            text = "".join(r.get("text", "") for r in runs).strip()
            if not text:
                continue

            segment = {"text": re.sub(r"\s+", " ", text).strip()}
            start_ms = seg_renderer.get("startMs")
            duration_ms = seg_renderer.get("durationMs")
            if start_ms is not None:
                try:
                    segment["start_ms"] = int(start_ms)
                    if duration_ms is not None:
                        segment["end_ms"] = int(start_ms) + int(duration_ms)
                except (ValueError, TypeError):
                    pass
            segments.append(segment)

        return segments if segments else None
    except (KeyError, IndexError, TypeError):
        return None


def try_android_player(html: str, video_id: str) -> list[dict] | None:
    """Try ANDROID client player API for caption tracks."""
    api_key = extract_innertube_api_key(html)
    if not api_key:
        return None

    payload = {
        "context": {
            "client": {
                "clientName": "ANDROID",
                "clientVersion": "20.10.38",
            }
        },
        "videoId": video_id,
    }

    data = fetch_json(
        f"https://www.youtube.com/youtubei/v1/player?key={api_key}",
        payload=payload,
    )
    if not data:
        return None

    tracks = get_caption_tracks(data)
    for track in tracks:
        base_url = track.get("baseUrl") or track.get("url")
        if not base_url:
            continue
        segments = download_caption_track(base_url)
        if segments:
            return segments

    return None


def format_timestamp(ms: int) -> str:
    """Format milliseconds as mm:ss or hh:mm:ss."""
    total_seconds = ms // 1000
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def main():
    ap = argparse.ArgumentParser(description="Extract YouTube video transcript")
    ap.add_argument("url", help="YouTube video URL")
    ap.add_argument("--timestamps", action="store_true", help="Include timestamps")
    ap.add_argument("--json", action="store_true", dest="json_output", help="JSON output with segments")
    ap.add_argument("--timeout", type=int, default=10, help="HTTP timeout (default: 10)")
    args = ap.parse_args()

    video_id = extract_video_id(args.url)
    if not video_id:
        print(f"Error: Could not extract video ID from: {args.url}", file=sys.stderr)
        sys.exit(1)

    watch_url = f"https://www.youtube.com/watch?v={video_id}"

    # Step 1: Fetch watch page
    try:
        html = fetch_url(watch_url, timeout=args.timeout)
    except Exception as e:
        print(f"Error fetching watch page: {e}", file=sys.stderr)
        sys.exit(1)

    # Extract video title
    title = None
    m = re.search(r'"title":"((?:[^"\\]|\\.)*)"', html)
    if m:
        title = m.group(1).encode().decode("unicode_escape", errors="replace")

    # Step 2: Try youtubei get_transcript endpoint (preferred)
    segments = None
    source = None

    segments = try_youtubei_transcript(html, watch_url)
    if segments:
        source = "youtubei"

    # Step 3: Try caption tracks from ytInitialPlayerResponse
    if not segments:
        player_response = extract_initial_player_response(html)
        if player_response:
            tracks = get_caption_tracks(player_response)
            for track in tracks:
                base_url = track.get("baseUrl") or track.get("url")
                if not base_url:
                    continue
                segments = download_caption_track(base_url)
                if segments:
                    source = "captionTracks"
                    break

    # Step 4: Try ANDROID player API
    if not segments:
        segments = try_android_player(html, video_id)
        if segments:
            source = "android_player"

    if not segments:
        print("Error: No transcript available for this video", file=sys.stderr)
        print("The video may not have captions, or they may be restricted.", file=sys.stderr)
        sys.exit(1)

    # Output
    if args.json_output:
        result = {
            "video_id": video_id,
            "title": title,
            "url": watch_url,
            "source": source,
            "segments": segments,
            "text": "\n".join(s["text"] for s in segments),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.timestamps:
        for seg in segments:
            ts = format_timestamp(seg["start_ms"]) if "start_ms" in seg else "?"
            print(f"[{ts}] {seg['text']}")
    else:
        print(f"# {title}\n" if title else "")
        print("\n".join(s["text"] for s in segments))


if __name__ == "__main__":
    main()
