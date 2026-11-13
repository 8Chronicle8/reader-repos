#!/usr/bin/env python3
"""
capture_api.py - load a page in a real (headless) browser and log every
network request it makes, so you can find the hidden JSON/API endpoint a
JS-rendered site uses for chapter content.

This is the tool for mapping where streamed-RSC / SPA sites (noveldex, novellunar,
brightnovels, wuxiaworld) where a plain fetch() of the page HTML does not
contain the chapter text.

Setup (once):
    pip install playwright
    python3 -m playwright install chromium

Usage:
    python3 tools/capture_api.py <url>
    python3 tools/capture_api.py <url> --filter chapter   # only URLs containing "chapter"
    python3 tools/capture_api.py <url> --save out.json     # dump full responses

What to look for in the output:
    A request whose RESPONSE contains the chapter prose (JSON with a
    "content"/"body"/"html" field, or an HTML fragment). That URL + its
    request headers are what your plugin's parseChapter should fetch.
"""

import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--filter", default="",
                    help="only show requests whose URL contains this substring")
    ap.add_argument("--save", help="write full request/response log to this JSON file")
    ap.add_argument("--wait", type=int, default=6,
                    help="seconds to wait after load for lazy requests (default 6)")
    ap.add_argument("--headed", action="store_true",
                    help="show the browser window (helpful for login/captcha)")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Playwright not installed. Run:\n"
                 "  pip install playwright\n"
                 "  python3 -m playwright install chromium")

    captured = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/126.0 Safari/537.36")

        def on_response(resp):
            url = resp.url
            if args.filter and args.filter.lower() not in url.lower():
                return
            ctype = resp.headers.get("content-type", "")
            # focus on data responses, skip images/fonts/css
            if any(x in ctype for x in ("image", "font", "css",
                                        "javascript", "video")):
                return
            body_preview = ""
            body_full = ""
            try:
                if "json" in ctype or "text" in ctype or ctype == "":
                    body_full = resp.text()
                    body_preview = body_full[:300].replace("\n", " ")
            except Exception:
                pass
            entry = {
                "url": url,
                "status": resp.status,
                "method": resp.request.method,
                "type": ctype.split(";")[0],
                "req_headers": dict(resp.request.headers),
                "preview": body_preview,
            }
            if args.save:
                entry["body"] = body_full
            captured.append(entry)

        page.on("response", on_response)

        print(f"[*] Loading {args.url} ...", file=sys.stderr)
        page.goto(args.url, wait_until="networkidle", timeout=45000)
        page.wait_for_timeout(args.wait * 1000)
        browser.close()

    # Report: rank by how "content-like" the response looks
    def score(e):
        p = e["preview"].lower()
        s = 0
        for kw in ('"content"', '"body"', '"chapter', '"text"', "<p>", "\\u003cp"):
            if kw in p:
                s += 2
        if "json" in e["type"]:
            s += 1
        if "/api/" in e["url"] or "graphql" in e["url"]:
            s += 2
        return s

    captured.sort(key=score, reverse=True)

    print(f"\n=== {len(captured)} data requests captured "
          f"(most content-like first) ===\n")
    for e in captured[:40]:
        print(f"[{e['status']}] {e['method']} {e['type']}")
        print(f"  {e['url']}")
        if e["preview"]:
            print(f"  preview: {e['preview'][:160]}")
        print()

    if args.save:
        json.dump(captured, open(args.save, "w"), indent=2)
        print(f"[+] Full log written to {args.save}")

    print("\nNext: pick the request whose preview holds the chapter prose,\n"
          "then build parseChapter to fetch that URL. See DEVELOPMENT.md.")


if __name__ == "__main__":
    main()
