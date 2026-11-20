#!/usr/bin/env bash
# Deploy the private copy of the dashboard (private/server.py) to Cloud Run behind IAP.
#
#   - Runs as fire-api-prod-admin-api, so it can read users from the admin API.
#   - IAP gets the same access list as the admin dashboard (fire-api-prod-admin),
#     so exactly the people who can open that one can open this one.
#   - No public access: requests only arrive through IAP.
#
# Run it yourself after `gcloud auth login`. gcloud may ask to enable APIs or to
# create an Artifact Registry repository for the build the first time; say yes.
# Re-running redeploys. Dashboard changes don't need a redeploy, since the
# service passes everything but /private/* through from the public site.
set -euo pipefail

PROJECT_ID="gentle-land-333822"
REGION="us-central1"
SERVICE="cornea-events-dashboard-private"
ADMIN_SERVICE="fire-api-prod-admin"
SERVICE_ACCOUNT="fire-api-prod-admin-api@${PROJECT_ID}.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

echo "Deploying ${SERVICE} ..."
gcloud beta run deploy "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" \
  --source="${ROOT}/private" \
  --service-account="$SERVICE_ACCOUNT" \
  --no-allow-unauthenticated --iap \
  --min-instances=0 --max-instances=2 --memory=256Mi --cpu=1 --concurrency=20

echo "Letting IAP invoke the service ..."
gcloud run services add-iam-policy-binding "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role="roles/run.invoker" >/dev/null

echo "Copying the admin dashboard's IAP access list ..."
policy=$(mktemp)
trap 'rm -f "$policy"' EXIT
gcloud iap web get-iam-policy --project="$PROJECT_ID" \
  --resource-type=cloud-run --service="$ADMIN_SERVICE" --region="$REGION" --format=json > "$policy"
python3 -I -c 'import json, sys
p = json.load(open(sys.argv[1]))
p.pop("etag", None)
json.dump(p, open(sys.argv[1], "w"))
print("  " + "\n  ".join(f"{b[\"role\"]}: {len(b.get(\"members\", []))} member(s)" for b in p.get("bindings", [])) or "  (no bindings)")' "$policy"
gcloud iap web set-iam-policy "$policy" --project="$PROJECT_ID" \
  --resource-type=cloud-run --service="$SERVICE" --region="$REGION" --quiet >/dev/null

echo
echo "Done. Private dashboard:"
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)'
