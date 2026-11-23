#!/usr/bin/env bash
# Turn the code-rubric reply into the verdict/merge result: exit 0 only for a
# valid reply whose checks all pass. Writes the reviewer and the rendered
# verdict to the job summary.
# Env: OUTCOME (rubric request outcome), RESPONSE_FILE, MODEL, FAMILY,
# AUTHOR_FAMILIES, HEAD_SHA. Runs from the workspace root with the shared
# scripts at .ai-workflows.
set -euo pipefail

scripts=.ai-workflows/.github/scripts/policy-gate
export RUBRIC=code REVIEW_TITLE=verdict/merge

printf '### Reviewer\n\n- model: %s (family %s)\n- author families: %s\n- head: %s\n\n' \
  "${MODEL:-}" "${FAMILY:-}" "${AUTHOR_FAMILIES:-}" "${HEAD_SHA:-}" >> "$GITHUB_STEP_SUMMARY"

if [ "${OUTCOME:-}" != success ]; then
  echo "::error::The router gave no verdict (${OUTCOME:-none})."
  exit 1
fi
if ! bash "$scripts/validate-verdict.sh"; then
  echo "::error::The reply is not a valid code verdict."
  exit 1
fi

bash "$scripts/render.sh"
cat policy-gate.md >> "$GITHUB_STEP_SUMMARY"
if [ "$(cat policy-gate.exit)" != 0 ]; then
  echo "::error::The code verdict found a failing check."
  exit 1
fi
echo "verdict/merge: MERGE"
