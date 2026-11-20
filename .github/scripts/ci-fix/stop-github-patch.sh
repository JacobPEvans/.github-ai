#!/usr/bin/env bash
# Hold back an agent patch that touches any .github/ path (workflows, actions,
# scripts): write touched=true|false to GITHUB_OUTPUT and, when stopped, put the
# patch in the step summary and exit 1, so the publish job fails and the
# failure comment reaches the pull request. Reads agent.patch from the working
# directory.
set -euo pipefail

if [ -s agent.patch ] && grep -qE '^diff --git a/\.github/' agent.patch; then
  echo "touched=true" >> "$GITHUB_OUTPUT"
  echo "::notice title=CI fix stopped by design::The patch edits .github/; it was not committed."
  {
    echo "### CI fix stopped by design"
    echo
    echo "The patch edits \`.github/\`, which the publisher does not commit."
    echo "The patch is in the \`ci-fix-${GITHUB_RUN_ID}\` artifact of this run."
    echo
    echo "<details><summary>Patch</summary>"
    echo
    echo '```diff'
    head -c 60000 agent.patch
    echo '```'
    echo
    echo "</details>"
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error title=CI fix stopped::The patch edits .github/; nothing was committed to the pull request."
  exit 1
else
  echo "touched=false" >> "$GITHUB_OUTPUT"
fi
