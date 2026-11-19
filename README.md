# Wildfire events dashboard

A dashboard of every event from the [Wildfire Explorer activity feed](https://fire-api-prod.web.app/events.atom), hosted on GitHub Pages.

**Live:** https://pasha594.github.io/cornea-events-dashboard/

## How it works

The feed only ever returns its latest 100 events, so on its own it forgets history.

- **Storage.** [`.github/workflows/poll-and-deploy.yml`](.github/workflows/poll-and-deploy.yml) runs every 15 minutes. It runs [`scripts/poll.py`](scripts/poll.py), which fetches the feed and merges any new entries into `site/data/events/YYYY-MM.json`, keyed by each entry's id. When something new arrives, the workflow commits the data and redeploys the site, so the repository is the full history.
- **Dashboard.** `site/` is a static page with no build step. It loads the stored history and also fetches the live feed directly (the feed allows cross-origin requests), so events newer than the last stored run still appear.

The feed publishes about 100 events a day in hourly batches, so a 15-minute poll keeps up comfortably. If more than 100 events ever arrived between two runs, the oldest of them would be lost; `poll.py` logs a warning in the Actions run when it sees no overlap with what is already stored.

## Run it locally

```bash
python3 scripts/poll.py                         # fetch the feed into site/data
python3 -m http.server 8000 --directory site    # then open http://localhost:8000
```

## Notes

- GitHub can pause scheduled workflows in a public repository after 60 days without activity. The data commits normally count as activity. If the schedule is ever paused, re-enable it from the Actions tab.
- Trigger a poll by hand from Actions → "Poll feed and deploy" → Run workflow.
