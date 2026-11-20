"""Shared storage for everything kept in site/data.

Each collection (events, alerts) is one JSON file per month, newest first, one
item per line for readable git diffs. site/data/manifest.json lists the files;
the dashboard reads it first. Event keys sit at the top level of the manifest
(for older dashboard code), alerts under "alerts".

Files are only rewritten when their content changes, so a run that finds
nothing new leaves the working tree clean and nothing gets committed.
"""

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "site" / "data"
MANIFEST = DATA_DIR / "manifest.json"


def write_if_changed(path, text):
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def load_manifest():
    return json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}


def save_manifest(manifest):
    return write_if_changed(MANIFEST, json.dumps(manifest, indent=2) + "\n")


def load_collection(name):
    items = {}
    for path in sorted((DATA_DIR / name).glob("*.json")):
        for item in json.loads(path.read_text(encoding="utf-8")):
            items[item["id"]] = item
    return items


def save_collection(name, items, time_key):
    """Write items to monthly files by `time_key`; return the manifest's month list."""
    folder = DATA_DIR / name
    folder.mkdir(parents=True, exist_ok=True)
    by_month = {}
    for item in items.values():
        month = (item.get(time_key) or "")[:7] or "unknown"
        by_month.setdefault(month, []).append(item)

    for month, rows in by_month.items():
        rows.sort(key=lambda i: (i.get(time_key) or "", i["id"]), reverse=True)
        lines = [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows]
        write_if_changed(folder / f"{month}.json", "[\n" + ",\n".join(lines) + "\n]\n")

    # An item whose date moved to another month leaves a stale file behind.
    for path in folder.glob("*.json"):
        if path.stem not in by_month:
            path.unlink()

    return [{"month": m, "file": f"{name}/{m}.json", "count": len(by_month[m])} for m in sorted(by_month, reverse=True)]


def save_events(events, now, manifest):
    """Store events and refresh the manifest's top-level event summary (other keys are kept)."""
    published = sorted(e["published"] for e in events.values() if e.get("published"))
    manifest.update({
        "updated_at": now,
        "total": len(events),
        "oldest": published[0] if published else None,
        "newest": published[-1] if published else None,
        "months": save_collection("events", events, "published"),
    })
    manifest.setdefault("gaps", [])
    save_manifest(manifest)
