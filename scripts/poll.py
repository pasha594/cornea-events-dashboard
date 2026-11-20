#!/usr/bin/env python3
"""Fetch the Wildfire Explorer Atom feed and merge its entries into site/data.

The feed only ever holds the latest 100 entries and needs no credentials. The
admin API (scripts/poll_admin.py) is the complete source and runs first; this
poller is the fallback that keeps events flowing if the API can't be reached.
It never overwrites an event the API already supplied, since those are richer.

If the feed is full and shares no entry with what is already stored, more than
100 events arrived since the last run and some may be lost. That gap is recorded
in the manifest (the dashboard shows it) and reported as gap=true in
$GITHUB_OUTPUT so the workflow can fail loudly.
"""

import os
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402

FEED_URL = "https://fire-api-prod.web.app/events.atom"
ATOM = "{http://www.w3.org/2005/Atom}"
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


def set_output(name, value):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def main():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entries = parse_feed(fetch(FEED_URL))
    stored = store.load_collection("events")
    manifest = store.load_manifest()
    gaps = manifest.get("gaps", [])

    gap = None
    if stored and len(entries) >= FEED_CAP and not any(e["id"] in stored for e in entries):
        # Every entry in a full feed is new: more than 100 events arrived since the
        # last run, so some were pushed out of the feed before we could store them.
        gap = {
            "after": max(e.get("published") or "" for e in stored.values()),
            "before": min(e.get("published") or "" for e in entries),
            "detected_at": now,
        }
        gaps.append(gap)
        print(f"WARNING: events may be missing between {gap['after']} and {gap['before']}", file=sys.stderr)
    set_output("gap", "true" if gap else "false")

    added = changed = 0
    for entry in entries:
        previous = stored.get(entry["id"])
        if previous is None:
            stored[entry["id"]] = {**entry, "first_seen": now}
            added += 1
        elif previous.get("source") == "api":
            continue  # the admin API's version of this event is richer; keep it
        elif any(previous.get(key) != value for key, value in entry.items()):
            stored[entry["id"]] = {**entry, "first_seen": previous.get("first_seen", now)}
            changed += 1

    print(f"Feed returned {len(entries)} entries: {added} new, {changed} changed, {len(stored)} stored in total")
    if added or changed or gap or not store.MANIFEST.exists():
        manifest["feed"] = FEED_URL
        manifest["gaps"] = gaps
        store.save_events(stored, now, manifest)


if __name__ == "__main__":
    main()
