#!/usr/bin/env python3
"""Fetch the Wildfire Explorer Atom feed and merge its entries into site/data.

The feed only ever holds the latest 100 entries, so this script runs on a
schedule and keeps every entry it has seen. Events are stored in one JSON file
per month (site/data/events/YYYY-MM.json, one event per line for readable git
diffs) plus site/data/manifest.json, which the dashboard reads first.

Files are only rewritten when the stored data actually changes, so a run that
finds nothing new leaves the working tree clean and nothing gets committed.
"""

import json
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

FEED_URL = "https://fire-api-prod.web.app/events.atom"
ATOM = "{http://www.w3.org/2005/Atom}"
DATA_DIR = Path(__file__).resolve().parent.parent / "site" / "data"
EVENTS_DIR = DATA_DIR / "events"
MANIFEST = DATA_DIR / "manifest.json"
FEED_CAP = 100  # the feed never returns more than this many entries


def fetch(url, attempts=3):
    request = urllib.request.Request(url, headers={"User-Agent": "events-dashboard-poller/1.0"})
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except Exception as error:  # network blips are common on shared runners
            if attempt == attempts:
                raise
            print(f"Fetch failed ({error}); retrying in {5 * attempt}s", file=sys.stderr)
            time.sleep(5 * attempt)


def child_text(element, tag):
    child = element.find(ATOM + tag)
    if child is None or child.text is None:
        return None
    return child.text.strip()


def parse_feed(xml_bytes):
    root = ET.fromstring(xml_bytes)
    entries = []
    for entry in root.findall(ATOM + "entry"):
        entry_id = child_text(entry, "id")
        if not entry_id:
            continue
        link = None
        for candidate in entry.findall(ATOM + "link"):
            if candidate.get("rel", "alternate") == "alternate":
                link = candidate.get("href")
                break
        category = entry.find(ATOM + "category")
        entries.append({
            "id": entry_id,
            "title": child_text(entry, "title"),
            "link": link,
            "published": child_text(entry, "published") or child_text(entry, "updated"),
            "updated": child_text(entry, "updated"),
            "category": category.get("term") if category is not None else None,
            "content": child_text(entry, "content"),
        })
    return entries


def load_stored():
    stored = {}
    for path in sorted(EVENTS_DIR.glob("*.json")):
        for event in json.loads(path.read_text(encoding="utf-8")):
            stored[event["id"]] = event
    return stored


def write_if_changed(path, text):
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def newest_first(event):
    return (event.get("published") or "", event["id"])


def save(events, now):
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    by_month = {}
    for event in events.values():
        month = (event.get("published") or "")[:7] or "unknown"
        by_month.setdefault(month, []).append(event)

    for month, month_events in by_month.items():
        month_events.sort(key=newest_first, reverse=True)
        lines = [json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in month_events]
        write_if_changed(EVENTS_DIR / f"{month}.json", "[\n" + ",\n".join(lines) + "\n]\n")

    # An event whose published date moved to another month leaves a stale shard behind.
    for path in EVENTS_DIR.glob("*.json"):
        if path.stem not in by_month:
            path.unlink()

    published = sorted(e["published"] for e in events.values() if e.get("published"))
    manifest = {
        "feed": FEED_URL,
        "updated_at": now,
        "total": len(events),
        "oldest": published[0] if published else None,
        "newest": published[-1] if published else None,
        "months": [
            {"month": month, "file": f"events/{month}.json", "count": len(by_month[month])}
            for month in sorted(by_month, reverse=True)
        ],
    }
    write_if_changed(MANIFEST, json.dumps(manifest, indent=2) + "\n")


def main():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entries = parse_feed(fetch(FEED_URL))
    stored = load_stored()

    if stored and len(entries) >= FEED_CAP and not any(e["id"] in stored for e in entries):
        # Every entry in a full feed is new: more than 100 events arrived since the
        # last run, so some were pushed out of the feed before we could store them.
        print("WARNING: no overlap with stored events; some events may have been missed", file=sys.stderr)

    added = changed = 0
    for entry in entries:
        previous = stored.get(entry["id"])
        if previous is None:
            stored[entry["id"]] = {**entry, "first_seen": now}
            added += 1
        elif any(previous.get(key) != value for key, value in entry.items()):
            stored[entry["id"]] = {**entry, "first_seen": previous.get("first_seen", now)}
            changed += 1

    print(f"Feed returned {len(entries)} entries: {added} new, {changed} changed, {len(stored)} stored in total")
    if added or changed or not MANIFEST.exists():
        save(stored, now)


if __name__ == "__main__":
    main()
