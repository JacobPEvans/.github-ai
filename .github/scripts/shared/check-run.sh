#!/usr/bin/env bash
# One check run per name on a head commit, so a rerun replaces the earlier outcome.
#
#   check-run.sh upsert <name> <conclusion> <title> <summary>   PATCH the latest run with
#                       this name from CHECK_APP_SLUG, or POST a new one
#   check-run.sh update <name> <conclusion> <title> <summary>   PATCH only; no matching run
#                       writes nothing
#
# Reads GH_TOKEN, GITHUB_REPOSITORY, CHECK_HEAD_SHA and CHECK_APP_SLUG. Without
# CHECK_APP_SLUG, or when the lookup fails, upsert POSTs with a warning and update
# exits 1. A refused write exits 1.
set -euo pipefail

usage() {
  echo "usage: check-run.sh <upsert|update> <name> <conclusion> <title> <summary>" >&2
  exit 2
}

[ "$#" -eq 5 ] || usage
command="$1"
name="$2"
conclusion="$3"
title="$4"
summary="$5"

case "$command" in
  upsert|update) ;;
  *) usage ;;
esac

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::check-run: GH_TOKEN must be set"
  exit 1
fi
if [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${CHECK_HEAD_SHA:-}" ]; then
  echo "::error::check-run: GITHUB_REPOSITORY and CHECK_HEAD_SHA must be set"
  exit 1
fi

run_id=""
lookup_error=""
if [ -z "${CHECK_APP_SLUG:-}" ]; then
  lookup_error="CHECK_APP_SLUG is empty"
else
  if lookup_response="$(gh api -X GET \
    "repos/$GITHUB_REPOSITORY/commits/$CHECK_HEAD_SHA/check-runs" \
    -f check_name="$name" \
    -f filter=latest \
    -f per_page=100 2>&1)"; then
    if ! run_id="$(jq -r \
      --arg name "$name" \
      --arg app_slug "$CHECK_APP_SLUG" \
      '(if type == "array" then . else (.check_runs // []) end)
       | map(select(.name == $name and .app.slug == $app_slug))
       | max_by([(.started_at // .completed_at // .created_at // ""), (.id // 0)])
       | .id // empty' <<< "$lookup_response" 2>/dev/null)"; then
      lookup_error="the check-run lookup returned invalid JSON"
    fi
  else
    lookup_error="the check-run lookup failed"
  fi
fi

if [ -n "$lookup_error" ]; then
  if [ "$command" = update ]; then
    echo "::error::check-run: $lookup_error; no check run was updated"
    exit 1
  fi
  echo "::warning::check-run: $lookup_error; creating a new check run"
fi

if [ "$command" = update ] && [ -z "$run_id" ]; then
  exit 0
fi

if [ -n "$run_id" ]; then
  endpoint="repos/$GITHUB_REPOSITORY/check-runs/$run_id"
  method=PATCH
  body="$(jq -n \
    --arg conclusion "$conclusion" \
    --arg title "$title" \
    --arg summary "$summary" \
    '{status: "completed", conclusion: $conclusion, output: {title: $title, summary: $summary}}')"
else
  endpoint="repos/$GITHUB_REPOSITORY/check-runs"
  method=POST
  body="$(jq -n \
    --arg name "$name" \
    --arg head_sha "$CHECK_HEAD_SHA" \
    --arg conclusion "$conclusion" \
    --arg title "$title" \
    --arg summary "$summary" \
    '{name: $name, head_sha: $head_sha, status: "completed", conclusion: $conclusion, output: {title: $title, summary: $summary}}')"
fi

gh api --method "$method" "$endpoint" --input - <<< "$body" >/dev/null
