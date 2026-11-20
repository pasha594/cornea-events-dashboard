#!/usr/bin/env python3
"""Fetch fire events and official alerts from the Wildfire Explorer admin API into site/data.

The API keeps every fire event for good and pages back through them, so this
fills in everything, however many events arrive between runs. Each run asks for
the newest page and keeps paging back until it reaches an item already stored;
the first run walks the whole history. Official alerts are only kept by the API
until a few days after they expire, so storing them here preserves them.

Needs ADMIN_TOKEN: an access token minted as fire-api-prod-admin-api. The
workflow gets one through Workload Identity; locally:

  ADMIN_TOKEN=$(gcloud auth print-access-token \
    --impersonate-service-account=fire-api-prod-admin-api@gentle-land-333822.iam.gserviceaccount.com \
    --scopes=openid,https://www.googleapis.com/auth/userinfo.email) python3 scripts/poll_admin.py

Users are never fetched here: their data stays behind IAP (see private/server.py).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402

API = os.environ.get("ADMIN_API", "https://fire-api-prod-admin-2ydhqyokxa-uc.a.run.app")
PAGE_LIMIT = 500


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # IAP redirects a refused token to Google sign-in; treat it as an error


opener = urllib.request.build_opener(NoRedirect)


def get(path, params, token):
    """One request at a time, honouring 429 Retry-After; a 503 means the page was too big."""
    limit = params.get("limit")
    for attempt in range(1, 8):
        query = urllib.parse.urlencode({k: v for k, v in {**params, "limit": limit}.items() if v not in (None, "")})
        request = urllib.request.Request(f"{API}{path}?{query}", headers={
            "Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "events-dashboard-poller/1.0",
        })
        try:
            with opener.open(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 429:
                wait = int(error.headers.get("Retry-After") or 10)
                print(f"Rate limited; waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
            elif error.code == 503 and limit and limit > 25:
                limit //= 2
                print(f"503 from {path}; retrying with limit={limit}", file=sys.stderr)
            elif error.code in (301, 302, 401, 403):
                raise SystemExit(f"Admin API refused the token ({error.code}). Check Workload Identity / ADMIN_TOKEN.")
            elif attempt < 3 and error.code >= 500:
                time.sleep(5 * attempt)
            else:
                raise
    raise SystemExit(f"Gave up on {path} after repeated rate limiting")


def walk(kind, known, token, full):
    """Newest first; stop after the first page that reaches a stored item, unless walking everything."""
    items, before, pages = [], "", 0
    while True:
        # Routine runs usually find a stored item on a small first page; go big only when catching up.
        limit = PAGE_LIMIT if full or pages else 50
        page = get(f"/api/{kind}", {"limit": limit, "before": before}, token)
        batch = page.get(kind, [])
        items.extend(batch)
        pages += 1
        before = page.get("next")
        if not before or (not full and any(item["id"] in known for item in batch)):
            return items, pages


def event_record(event, previous, now):
    fire = event.get("fire") or {}
    return {
        "id": event["id"],
        "title": event.get("title"),
        "link": fire.get("url"),
        "published": event.get("occurred_at"),
        "updated": event.get("occurred_at"),
        "category": event.get("kind"),
        "summary": event.get("summary"),
        "facts": event.get("facts"),
        "cornea_id": fire.get("cornea_id"),
        "fire_name": fire.get("name"),
        "source": "api",
        "first_seen": (previous or {}).get("first_seen", now),
    }


def merge(stored, records):
    added = changed = 0
    for record in records:
        previous = stored.get(record["id"])
        if previous is None:
            added += 1
        elif {k: v for k, v in previous.items() if k != "first_seen"} == {k: v for k, v in record.items() if k != "first_seen"}:
            continue
        else:
            changed += 1
        stored[record["id"]] = record
    return added, changed


def main():
    token = os.environ.get("ADMIN_TOKEN")
    if not token:
        raise SystemExit("ADMIN_TOKEN is not set")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = store.load_manifest()
    backfilled = manifest.setdefault("api_backfilled", {})

    # ----- fire events -----
    events = store.load_collection("events")
    api_known = {i for i, e in events.items() if e.get("source") == "api"}
    raw, pages = walk("events", api_known, token, full=not backfilled.get("events"))
    added, changed = merge(events, [event_record(e, events.get(e["id"]), now) for e in raw])
    print(f"Events: read {len(raw)} in {pages} page(s): {added} new, {changed} updated, {len(events)} stored")
    if added or changed or not backfilled.get("events"):
        backfilled["events"] = True
        manifest.setdefault("feed", "https://fire-api-prod.web.app/events.atom")
        store.save_events(events, now, manifest)

    # ----- official alerts -----
    alerts = store.load_collection("alerts")
    raw, pages = walk("alerts", set(alerts), token, full=not backfilled.get("alerts"))
    fire_urls = {e["cornea_id"]: e["link"] for e in events.values() if e.get("cornea_id") and e.get("link")}
    records = []
    for alert in raw:
        fire = alert.get("fire") or None
        if fire and fire.get("cornea_id") and fire["cornea_id"] not in fire_urls and alert["id"] not in alerts:
            # The alert names a fire we have no events for yet: ask the API for its page once.
            found = get("/api/events", {"limit": 1, "cornea_id": fire["cornea_id"]}, token).get("events", [])
            fire_urls[fire["cornea_id"]] = (found[0].get("fire") or {}).get("url") if found else None
        previous = alerts.get(alert["id"])
        records.append({
            **alert,
            "fire_url": fire_urls.get(fire["cornea_id"]) if fire else None,
            "first_stored": (previous or {}).get("first_stored", now),
        })
    added_a, changed_a = 0, 0
    for record in records:
        previous = alerts.get(record["id"])
        if previous is None:
            added_a += 1
        elif {k: v for k, v in previous.items() if k != "first_stored"} == {k: v for k, v in record.items() if k != "first_stored"}:
            continue
        else:
            changed_a += 1
        alerts[record["id"]] = record
    print(f"Alerts: read {len(raw)} in {pages} page(s): {added_a} new, {changed_a} updated, {len(alerts)} stored")
    if added_a or changed_a or not backfilled.get("alerts"):
        backfilled["alerts"] = True
        manifest["alerts"] = {
            "updated_at": now,
            "total": len(alerts),
            "months": store.save_collection("alerts", alerts, "sent_at"),
        }
        manifest["api_backfilled"] = backfilled
        store.save_manifest(manifest)


if __name__ == "__main__":
    main()
