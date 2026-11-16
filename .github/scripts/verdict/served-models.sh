#!/usr/bin/env bash
# List the model names the router serves to this key, one per line, into the
# step output `models` and the job summary.
# Env: BASE_URL (router base ending in /v1), API_KEY.
set -euo pipefail

: "${BASE_URL:?BASE_URL is required}"
: "${API_KEY:?API_KEY is required}"

models="$(curl -fsS --max-time 20 -H "Authorization: Bearer $API_KEY" "$BASE_URL/models" | jq -r '.data[].id' | sort -u)"
test -n "$models" || { echo "::error::The router listed no models for this key." >&2; exit 1; }

{
  echo 'models<<EOF'
  echo "$models"
  echo 'EOF'
} >> "$GITHUB_OUTPUT"

{
  echo '### Router models served to this key'
  echo
  while IFS= read -r model; do echo "- $model"; done <<< "$models"
  echo
} >> "$GITHUB_STEP_SUMMARY"
