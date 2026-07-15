#!/usr/bin/env bash
# Apply browser CORS rules to the outputs bucket (project: x-landing-465917-t7).
# Required for: direct uploads (PUT) from NodeODM + tileset viewers (GET/Range).
#
# Usage:
#   gcloud config set project x-landing-465917-t7
#   ./scripts/apply-gcs-cors.sh
#   ./scripts/apply-gcs-cors.sh my-other-bucket
#
# Verify:
#   gsutil cors get gs://nodeodm-outputs-v1

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${1:-${GCS_BUCKET:-nodeodm-outputs-v1}}"
CORS_FILE="${ROOT}/scripts/gcs-bucket-cors.json"

if [[ ! -f "$CORS_FILE" ]]; then
  echo "Missing $CORS_FILE" >&2
  exit 1
fi

echo "Applying CORS from $CORS_FILE to gs://${BUCKET} ..."
gsutil cors set "$CORS_FILE" "gs://${BUCKET}"
echo ""
echo "Current CORS configuration:"
gsutil cors get "gs://${BUCKET}"
