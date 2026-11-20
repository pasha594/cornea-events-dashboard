# Wildfire events dashboard

A dashboard of Wildfire Explorer fire events and official (IPAWS) alerts, hosted on GitHub Pages, plus a private copy with a Users tab.

**Live:** https://pasha594.github.io/cornea-events-dashboard/

## How data gets stored

Everything the dashboard shows is stored in `site/data/` (one JSON file per month, listed in `site/data/manifest.json`) by [`.github/workflows/poll-and-deploy.yml`](.github/workflows/poll-and-deploy.yml), which runs every 5 minutes, commits anything new and redeploys the site.

- **Admin API (complete source).** [`scripts/poll_admin.py`](scripts/poll_admin.py) reads fire events and official alerts from the Wildfire Explorer admin API. The API keeps every fire event for good and pages back through them, so each run walks back from the newest until it reaches something already stored. Nothing is lost however many events arrive between runs, or however late GitHub runs the schedule. Alerts are only kept by the API until a few days after they expire, so storing them here preserves them.
- **Public feed (fallback).** [`scripts/poll.py`](scripts/poll.py) reads the [Atom feed](https://fire-api-prod.web.app/events.atom), which needs no credentials but only holds the latest 100 events. It runs after the API step and never overwrites an event the API supplied. If the feed overflowed and the API couldn't fill the gap, the gap is recorded and shown on the dashboard, and the workflow fails on purpose so GitHub sends a notification.

The page also reads the live feed directly, so the newest events show up before they are stored.

### Admin API access (Workload Identity)

The admin API sits behind Google IAP and accepts tokens minted as the `fire-api-prod-admin-api` service account. The workflow gets one without any key through Workload Identity Federation: GitHub's identity token for a run on this repo's `main` branch is exchanged for a one-hour access token. Nobody has to sign in, ever.

One-time setup, by someone allowed to manage workload identity pools and the service account's IAM in `gentle-land-333822`:

```bash
scripts/setup-workload-identity.sh
```

Then switch the workflow's admin API step on:

```bash
gh variable set ADMIN_API --body on --repo pasha594/cornea-events-dashboard
```

Until then, the workflow stores events from the public feed only.

## Users tab (private copy)

Users data (emails, sign-in times, subscription locations, alert emails) is personal, so it never goes into this repository or onto the public site. [`private/server.py`](private/server.py) is a small server for Cloud Run behind IAP, with the same access list as the admin dashboard. It runs as the admin API's service account, answers `/private/users*` live from the admin API without storing anything, and passes every other request through from the public site, so the private copy always runs the current dashboard and shows a Users tab. Deploy it (needs Cloud Run, Cloud Build and IAP admin rights in the project):

```bash
scripts/deploy-private.sh
```

## Filtering

Filters for time range, event type, state, fire and search apply to the whole Fire events tab. The event log has its own filter row, and clicking a type, fire or state in any row filters to it. Filters and the open tab are saved in the URL, so a filtered view can be shared.

## Run it locally

```bash
python3 scripts/poll.py                         # fetch the public feed into site/data
python3 -m http.server 8000 --directory site    # then open http://localhost:8000
```

With access to the admin API (you can act as its service account):

```bash
ADMIN_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=fire-api-prod-admin-api@gentle-land-333822.iam.gserviceaccount.com \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email) python3 scripts/poll_admin.py
```

The private copy, locally, with your own `gcloud` login:

```bash
IMPERSONATE=fire-api-prod-admin-api@gentle-land-333822.iam.gserviceaccount.com PORT=8080 python3 private/server.py
```

## Notes

- GitHub runs scheduled workflows on a best-effort basis and can pause them in a public repository after 60 days without activity. The data commits normally count as activity. If the schedule is ever paused, re-enable it from the Actions tab. Because the admin API keeps everything, a missed run only delays storing.
- Trigger a poll by hand from Actions → "Poll feed and deploy" → Run workflow.
