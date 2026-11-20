#!/usr/bin/env bash
# One-time setup: let this repo's GitHub Actions act as the admin API's service
# account without any key, so scheduled runs never need anyone to sign in.
#
#   1. A dedicated workload identity pool and a GitHub OIDC provider. The provider
#      only accepts tokens from this repo (matched by GitHub's numeric ids, which
#      survive renames and can't be claimed by a new repo with the same name) and
#      only from the main branch.
#   2. One IAM binding: identities from that repo may impersonate
#      fire-api-prod-admin-api, the account the admin API's IAP already accepts.
#
# Run it yourself after `gcloud auth login`. You need permission to manage
# workload identity pools in the project and IAM on that service account.
# Safe to re-run: existing pieces are left as they are.
set -euo pipefail

PROJECT_ID="gentle-land-333822"
SERVICE_ACCOUNT="fire-api-prod-admin-api@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_ID="cornea-events-dashboard"
PROVIDER_ID="github"
REPO_ID="1464691632"   # github.com/pasha594/cornea-events-dashboard
OWNER_ID="305999177"   # github.com/pasha594

echo "Checking that you can act as ${SERVICE_ACCOUNT} ..."
gcloud auth print-access-token --impersonate-service-account="$SERVICE_ACCOUNT" \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email >/dev/null 2>&1 || {
  echo "Could not mint a token as ${SERVICE_ACCOUNT}. Run 'gcloud auth login' and check you are on the admin dashboard's access list." >&2
  exit 1
}

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

if gcloud iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "Pool ${POOL_ID} already exists"
else
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" --location=global \
    --display-name="cornea-events-dashboard" \
    --description="GitHub Actions in pasha594/cornea-events-dashboard"
fi

if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT_ID" \
    --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  echo "Provider ${PROVIDER_ID} already exists"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --display-name="GitHub Actions" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository_id == '${REPO_ID}' && assertion.repository_owner_id == '${OWNER_ID}' && assertion.ref == 'refs/heads/main'"
fi

gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository_id/${REPO_ID}" \
  --condition=None >/dev/null

echo
echo "Done. Workload identity provider:"
echo "  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
