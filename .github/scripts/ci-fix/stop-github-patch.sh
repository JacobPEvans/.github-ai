#!/usr/bin/env bash
# Hold back an agent patch that touches any .github/ path (workflows, actions,
# scripts): write touched=true|false to GITHUB_OUTPUT. A held patch is not
# committed; the step summary names the run's patch artifact, never the patch
# body, and the job hands the fix to a person. Reads agent.patch from the
# working directory.
set -euo pipefail

if [ -s agent.patch ] && grep -qE '^diff --git a/\.github/' agent.patch; then
  echo "touched=true" >> "$GITHUB_OUTPUT"
  echo "::notice title=CI fix handed off::The patch edits .github/; it was not committed."
  {
    echo "### CI fix handed off"
    echo
    echo "The patch edits \`.github/\`, which the publisher does not commit."
    echo "The patch is in the \`ci-fix-$GITHUB_RUN_ID\` artifact of this run."
  } >> "$GITHUB_STEP_SUMMARY"
else
  echo "touched=false" >> "$GITHUB_OUTPUT"
fi
