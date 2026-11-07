#!/usr/bin/env bash
# Validate a rubric verdict before anything renders it. Exits 0 when RESPONSE_FILE is a
# verdict for RUBRIC, 1 when it is not, 2 for an unknown rubric. Leak findings without a
# verifiable added line are removed; private-host findings also need a candidate. Unparsed paths
# stay fail-closed. Dropped findings are recorded in GITHUB_STEP_SUMMARY.
#
# The fixed rubrics (policy, security, semantic) return exactly one finding per check, so a
# verdict must name each of its checks once and no other. The leak rubric returns one finding
# per suspected item, and an empty array when nothing matches, so its verdict may repeat a
# category and may have no findings. Every rubric accepts only the keys the renderer reads.
set -euo pipefail

: "${RUBRIC:?RUBRIC is required}"
: "${RESPONSE_FILE:?RESPONSE_FILE is required}"

case "$RUBRIC" in
  policy) names='dry native_first disclosure missing_test token_budget'; exact=1 ;;
  security) names='auth injection permission_widening unsafe_trigger secret_handling'; exact=1 ;;
  leak) names='credential private_host_or_ip internal_topology incident_detail'; exact=0 ;;
  semantic) names='claim_mismatch omitted_behavior'; exact=1 ;;
  *) echo "::error::Unknown rubric: $RUBRIC" >&2; exit 2 ;;
esac

jq -e --arg names "$names" --arg rubric "$RUBRIC" --argjson exact "$exact" '
  ($names | split(" ")) as $allowed |
  type == "object" and
  ((keys - ["findings", "summary"]) | length == 0) and
  (.summary | type == "string") and
  (.findings | type == "array") and
  all(.findings[];
    type == "object" and
    ((keys - ["check", "result", "file", "line", "detail"]) | length == 0) and
    (.check | type == "string") and
    (if $rubric == "leak" and .result == "fail" then true
     else (.check as $c | $allowed | any(. == $c))
     end) and
    (.result == "pass" or .result == "fail") and
    (.file | type == "string") and
    (.line | type == "number") and
    (.detail | type == "string")) and
  (if $exact == 1
   then ((.findings | map(.check) | sort) == ($allowed | sort))
   else true
   end) and
  (if $rubric == "leak"
   then all(.findings[]; .result != "fail" or
     ((.file | length) > 0 and .line > 0 and (.line | floor) == .line))
   else true
   end)
' "$RESPONSE_FILE" > /dev/null

if [[ "$RUBRIC" != leak ]]; then
  exit 0
fi

cleanup() {
  [[ -z "${DIFF_TEMP:-}" ]] || rm -f -- "$DIFF_TEMP"
  [[ -z "${RESULT_TEMP:-}" ]] || rm -f -- "$RESULT_TEMP"
  [[ -z "${FILTER_TEMP:-}" ]] || rm -f -- "$FILTER_TEMP"
  [[ -z "${RESPONSE_TEMP:-}" ]] || rm -f -- "$RESPONSE_TEMP"
}
trap cleanup EXIT

if [[ -n "${RUNNER_TEMP:-}" ]]; then
  TEMP_DIR="$RUNNER_TEMP"
elif [[ -n "${TMPDIR:-}" ]]; then
  TEMP_DIR="$TMPDIR"
elif [[ -d /private/tmp ]]; then
  TEMP_DIR=/private/tmp
else
  TEMP_DIR=/tmp
fi
new_temp() {
  mktemp "$TEMP_DIR/policy-gate.XXXXXXXX"
}

diff_file="${DIFF_FILE:-}"
expected_counts=""
if [[ -z "$diff_file" ]]; then
  : "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required for leak validation}"
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required for leak validation}"
  [[ "${GITHUB_SERVER_URL:-https://github.com}" == https://github.com ]] || {
    echo "::error::Leak patch retrieval requires github.com" >&2
    exit 1
  }
  [[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "::error::GITHUB_REPOSITORY is not a repository name" >&2
    exit 1
  }
  pull_number="$(jq -er '.pull_request.number | select(type == "number" and . > 0 and floor == .)' "$GITHUB_EVENT_PATH")"
  expected_counts="$(jq -er '
    .pull_request as $pr
    | select($pr.changed_files | type == "number" and . >= 0 and floor == .)
    | select($pr.additions | type == "number" and . >= 0 and floor == .)
    | select($pr.deletions | type == "number" and . >= 0 and floor == .)
    | [$pr.changed_files, $pr.additions, $pr.deletions] | @tsv
  ' "$GITHUB_EVENT_PATH")"
  DIFF_TEMP="$(new_temp)"
  diff_status="$(curl --silent --show-error --fail --max-time 30 --max-filesize 10485760 \
    --header 'Accept: application/vnd.github.diff' \
    --output "$DIFF_TEMP" --write-out '%{http_code}' \
    "https://api.github.com/repos/$GITHUB_REPOSITORY/pulls/$pull_number")"
  [[ "$diff_status" == 200 ]] || {
    echo "::error::Could not retrieve the pull request diff for leak validation" >&2
    exit 1
  }
  diff_file="$DIFF_TEMP"
fi

[[ -r "$diff_file" ]] || {
  echo "::error::The leak diff is not readable" >&2
  exit 1
}

RESULT_TEMP="$(new_temp)"
jq -n --rawfile patch "$diff_file" '
  ($patch | split("\n"))
  | reduce .[] as $row
      ({files: [], added: [], sections: 0, added_count: 0, removed_count: 0, unknown_path: false,
        file: null, new_line: 0, in_hunk: false};
       if ($row | startswith("diff --git ")) then
         .file = null | .new_line = 0 | .in_hunk = false | .sections += 1
       elif (has("in_hunk") and (.in_hunk | not)) and ($row | startswith("+++ ")) then
         if ($row | startswith("+++ b/")) then
           ($row[6:]) as $path
           | .file = $path
           | .new_line = 0
           | .files += [$path]
         elif $row == "+++ /dev/null" then
           .file = null | .new_line = 0
         else
           .file = null | .new_line = 0 | .unknown_path = true
         end
       elif ($row | startswith("@@ ")) then
         ($row | capture("\\+(?<start>[0-9]+)").start | tonumber) as $start
         | .new_line = $start
         | .in_hunk = true
       elif .in_hunk and ($row | startswith("+")) then
         (if .file == null then . else
            .added += [{file: .file, line: .new_line, text: $row[1:]}]
          end)
         | .new_line += 1
         | .added_count += 1
       elif .in_hunk and ($row | startswith(" ")) then
         .new_line += 1
       elif .in_hunk and ($row | startswith("-")) then
         .removed_count += 1
       else .
       end)
  | {files: (.files | unique), added: .added, sections: .sections,
     added_count: .added_count, removed_count: .removed_count, unknown_path: .unknown_path}
' > "$RESULT_TEMP"

parsed_counts="$(jq -r '[.sections, .added_count, .removed_count] | @tsv' "$RESULT_TEMP")"
if [[ -n "$expected_counts" ]]; then
  [[ "$parsed_counts" == "$expected_counts" ]] || {
    echo "::error::The pull request diff is incomplete" >&2
    exit 1
  }
fi

FILTER_TEMP="$(new_temp)"
jq --slurpfile patch "$RESULT_TEMP" '
  def ipv6_shape:
    test("(?i)^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:/[0-9]{1,3})?$");
  def tokens($text):
    ($text | gsub("[[:space:]\";,()\\[\\]{}<> =]+"; " ") | gsub("\u0027"; " ") | gsub("\u0060"; " ") | split(" ") | map(select(length > 0)))
    | map(if ipv6_shape then . else sub("[.,:;!?]+$"; "") end | select(length > 0));
  # shortcut: a bare one-word name with no host-like key is not a candidate; the disclosure denylist gate holds known private names, so upgrade only if a real name passes both
  def is_candidate($previous):
    test("(?i)^[a-z][a-z0-9+.-]*://[^/?#]+") or
    test("(?i)^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$") or
    test("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}(?::[0-9]+|/[0-9]{1,2})?$") or
    test("(?i)^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,63}$") or
    ipv6_shape or
    (test("(?i)[a-z]") and (test("[0-9]") or contains("-"))) or
    (($previous | test("(?i)^(host|hostname|server|node|addr|endpoint|url):?$")) and
      test("(?i)^[a-z][a-z0-9_-]*$"));
  # Centralized values named by the leak rubric: example domains, RFC 5737, RFC 3849.
  def documentation_values:
    [
      "(?i)^(?:[a-z][a-z0-9+.-]*://)?(?:[a-z0-9._%+-]+@)?(?:[a-z0-9-]+\\.)*example\\.(?:com|test)(?::[0-9]+)?(?:[/#?].*)?$",
      "^(?:192\\.0\\.2|198\\.51\\.100|203\\.0\\.113)\\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
      "(?i)^2001:(?:0{0,3}db8)(?::[0-9a-f]{0,4}){1,6}$"
    ];
  def matches_documentation: . as $value | any(documentation_values[]; . as $pattern | $value | test($pattern));
  def is_exempt:
    . as $token
    | if ($token | test("(?i)^[a-z][a-z0-9+.-]*://")) then
        if ($token | test("(?i)^[a-z][a-z0-9+.-]*://[^/?#]*@")) then false
        else
          ($token
           | sub("(?i)^[a-z][a-z0-9+.-]*://"; "")
           | sub("[/?#].*$"; "")
           | sub(":([0-9]+)$"; ""))
          | matches_documentation
        end
      else $token | matches_documentation
      end;
  def real_candidates($text):
    tokens($text) as $tokens
    | [range(0; ($tokens | length)) as $index
       | $tokens[$index] as $token
       | (if $index == 0 then "" else $tokens[$index - 1] end) as $previous
       | select($token | is_candidate($previous))
       | select($token | is_exempt | not)
       | $token];
  def real_path($path; $diff):
    if any($diff.files[]; . == $path) then $path
    elif ($path | startswith("b/")) and any($diff.files[]; . == $path[2:]) then $path[2:] else null end;
  def reason($finding; $diff):
    $finding.file as $path
    | real_path($path; $diff) as $real_path
    | if $real_path == null then
        if $diff.unknown_path then null else "path_not_in_diff" end
      else
        ([$diff.added[] | select(.file == $real_path and .line == $finding.line)] | first) as $line
        | if $line == null then "line_not_added"
          elif $finding.check == "private_host_or_ip" and (real_candidates($line.text) | length) == 0 then "no_candidate"
          else null
          end
      end;
  . as $verdict
  | $patch[0] as $diff
  | (reduce $verdict.findings[] as $finding
      ({kept: [], dropped: []};
       if $finding.result != "fail" then .kept += [$finding]
       else
         reason($finding; $diff) as $reason
         | if $reason == null then .kept += [$finding]
           else .dropped += [{file: $finding.file, line: $finding.line, reason: $reason}]
           end
       end)) as $partition
  | {
      verdict: ($verdict | .findings = $partition.kept),
      ungrounded: $partition.dropped
    }
' "$RESPONSE_FILE" > "$FILTER_TEMP" 2> /dev/null || {
  echo "::error::Could not validate leak findings against the pull request diff" >&2
  exit 1
}

RESPONSE_TEMP="$(new_temp)"
jq '.verdict' "$FILTER_TEMP" > "$RESPONSE_TEMP"
mv -- "$RESPONSE_TEMP" "$RESPONSE_FILE"
RESPONSE_TEMP=""

summary="$(jq -r '
  .ungrounded[] |
  "UNGROUNDED | \(.file | tostring | gsub("[|\\r\\n]"; "_")):\(.line) | \(.reason)"
' "$FILTER_TEMP")"
if [[ -n "$summary" ]]; then
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '%s\n' "$summary" >&2
  fi
fi
