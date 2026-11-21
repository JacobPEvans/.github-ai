#!/usr/bin/env bash
# Collect a pull request's diff plus a per-file size table, for the fixed
# five-check rubric in policy-gate.prompt.yml. Writes: diff.txt, changed.txt, sizes.txt
#
# Unlike docs-drift's collect.sh (which diffs one merged commit against its
# parent), a PR can carry many commits, so the base is passed explicitly.
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
max_diff_kb="${MAX_DIFF_KB:-150}"

git diff --name-only "$BASE_SHA...$HEAD_SHA" > changed.txt

diff_options=()
if [ "${RUBRIC:-policy}" = "leak" ]; then
  diff_options+=(--unified=0)
fi

git diff "${diff_options[@]}" "$BASE_SHA...$HEAD_SHA" |
  sed -E 's/\$\{\{[[:space:]]*secrets\.([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*\}\}/<secret-reference:\1>/g' |
  if [ "${RUBRIC:-policy}" = "leak" ]; then
    sed -E "s/^[+][[:blank:]]*[A-Za-z_][A-Za-z0-9_.-]*[:=][[:blank:]\"']*<secret-reference:[A-Za-z_][A-Za-z0-9_]*>[[:blank:]\"']*$/+<reference-only line>/"
  else
    cat
  fi > diff.full.txt
head -c "$((max_diff_kb * 1024))" diff.full.txt > diff.txt
if [ "$(wc -c < diff.full.txt)" -gt "$((max_diff_kb * 1024))" ]; then
  printf '\n[diff truncated at %s KiB]\n' "$max_diff_kb" >> diff.txt
fi
rm -f diff.full.txt

# Per-changed-file line count: cheap context for the token-budget finding.
# The authoritative gate is `ci / Token Limits / Check` (tiktoken-counted
# elsewhere); this is advisory pattern-matching, not a second enforcement.
: > sizes.txt
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  printf '%s: %s lines\n' "$f" "$(wc -l < "$f")" >> sizes.txt
done < changed.txt

# A changed workflow can hand its trigger and secrets to a reusable workflow
# whose guards the diff does not show. For the security rubric, up to three
# such workflows go after the diff, read at the ref they are called at. Only
# the reviewed repository's owner and the shared workflow repository's owner
# are read; text from any other owner never reaches the reviewer.
if [ "${RUBRIC:-policy}" = "security" ]; then
  trusted_owners=" ${GITHUB_REPOSITORY_OWNER:-} JacobPEvans "
  trusted_owners=$(printf '%s' "$trusted_owners" | tr '[:upper:]' '[:lower:]')
  max_called=3
  max_file_bytes=$((24 * 1024))
  max_context_bytes=$((64 * 1024))
  while IFS= read -r f; do
    [[ "$f" =~ ^\.github/workflows/[^/]+\.ya?ml$ && -f "$f" ]] || continue
    grep -oE 'uses:[[:space:]]*[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/\.github/workflows/[A-Za-z0-9_.-]+@[A-Za-z0-9_./-]+' "$f" || true
  done < changed.txt | sed -E 's/^uses:[[:space:]]*//' | sort -u > called.refs
  read_count=0
  : > called.txt
  while IFS= read -r ref; do
    owner=$(printf '%s' "${ref%%/*}" | tr '[:upper:]' '[:lower:]')
    if [[ "$trusted_owners" != *" $owner "* ]]; then
      printf 'External reusable workflow %s is called; it was not read.\n\n' "$ref" >> called.txt
      continue
    fi
    if [ "$read_count" -ge "$max_called" ]; then
      printf 'Reusable workflow %s is called; it was not read (limit %s).\n\n' "$ref" "$max_called" >> called.txt
      continue
    fi
    workflow=".github/${ref#*/.github/}"
    if ! gh api -H "Accept: application/vnd.github.raw" \
      "repos/${ref%%/.github/*}/contents/${workflow%@*}?ref=${ref##*@}" > called.yml; then
      echo "::warning::could not read the called workflow $ref"
      continue
    fi
    read_count=$((read_count + 1))
    {
      printf 'CALLED REUSABLE WORKFLOW %s, context only and not part of this pull request (first %s KiB):\n' \
        "$ref" "$((max_file_bytes / 1024))"
      head -c "$max_file_bytes" called.yml
      printf '\n----- end of called reusable workflow -----\n\n'
    } >> called.txt
  done < called.refs
  if [ -s called.txt ]; then
    {
      printf '\n----- end of the diff; context follows -----\n\n'
      head -c "$max_context_bytes" called.txt
      if [ "$(wc -c < called.txt)" -gt "$max_context_bytes" ]; then
        printf '\n[context truncated at %s KiB]\n' "$((max_context_bytes / 1024))"
      fi
    } >> diff.txt
  fi
  rm -f called.refs called.txt called.yml
fi

echo "changed files: $(wc -l < changed.txt)"
