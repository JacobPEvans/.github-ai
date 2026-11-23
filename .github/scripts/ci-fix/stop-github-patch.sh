#!/usr/bin/env bash
# Hold back an agent patch the publisher must not commit: write touched=true|false
# and, when held, reason=<sentence> to GITHUB_OUTPUT. A patch is held when it
# touches any .github/ path, touches more than 25 files, or adds a file under a
# dependency install path (node_modules/, .venv/, collections/, or
# roles/<namespace>.<name>/ for a role named in requirements.yml) or under a path
# the repository's ignore rules exclude. Removing files from a dependency install
# path undoes an earlier bad commit, so those removals do not count toward the 25.
# A held patch is not committed; the step
# summary names the run's patch artifact, never the patch body, and the job hands
# the fix to a person. Reads agent.patch and the checkout in the working directory.
set -euo pipefail

max_files=25
reason=""

if [ -s agent.patch ]; then
  paths=$(sed -nE 's#^diff --git a/(.*) b/.*#\1#p' agent.patch)
  added=$(awk '/^diff --git /{p=$3; sub(/^a\//, "", p)} /^new file mode/{print p}' agent.patch)
  removed=$(awk '/^diff --git /{p=$3; sub(/^a\//, "", p)} /^deleted file mode/{print p}' agent.patch)
  roles=$(cat requirements.yml roles/requirements.yml 2>/dev/null |
    sed -nE "s/^[[:space:]-]*(name|src):[[:space:]]*[\"']?([A-Za-z0-9_]+\.[A-Za-z0-9_]+)[\"']?[[:space:]]*$/\2/p" | sort -u || true)

  # Prints the kind of dependency install path a file is under, or nothing.
  dependency_path() {
    local role
    if [[ "$1" =~ (^|/)(node_modules|\.venv)/ || "$1" == collections/* ]]; then echo install; return; fi
    role=$(sed -nE 's#^roles/([^/]+)/.*#\1#p' <<<"$1")
    if [ -n "$role" ] && grep -qxF -- "$role" <<<"$roles"; then echo "role:$role"; fi
  }

  repairs=0
  while IFS= read -r path; do
    if [ -n "$path" ] && [ -n "$(dependency_path "$path")" ]; then repairs=$((repairs + 1)); fi
  done <<<"$removed"
  count=$(( $(printf '%s\n' "$paths" | grep -c . || true) - repairs ))

  if grep -q '^\.github/' <<<"$paths"; then
    reason="The patch edits files under \`.github/\`"
  elif [ "$count" -gt "$max_files" ]; then
    reason="The patch touches $count files, more than $max_files"
  else
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      kind=$(dependency_path "$path")
      if [ "$kind" = install ]; then
        reason="The patch adds files under a dependency install path (node_modules/, .venv/ or collections/)"
        break
      fi
      if [ -n "$kind" ]; then
        reason="The patch adds files under \`roles/${kind#role:}/\`, a role installed from requirements.yml"
        break
      fi
      if git check-ignore --no-index -q -- "$path" 2>/dev/null; then
        reason="The patch adds a file the repository's ignore rules exclude"
        break
      fi
    done <<<"$added"
  fi
fi

if [ -n "$reason" ]; then
  echo "touched=true" >> "$GITHUB_OUTPUT"
  echo "reason=$reason" >> "$GITHUB_OUTPUT"
  echo "::notice title=CI fix handed off::$reason; it was not committed."
  {
    echo "### CI fix handed off"
    echo
    echo "$reason, which the publisher does not commit."
    echo "The patch is in the \`ci-fix-$GITHUB_RUN_ID\` artifact of this run."
  } >> "$GITHUB_STEP_SUMMARY"
else
  echo "touched=false" >> "$GITHUB_OUTPUT"
fi
