#!/usr/bin/env bash
# Validate a rubric verdict before anything renders it. Exits 0 when RESPONSE_FILE is a
# verdict for RUBRIC, 1 when it is not, 2 for an unknown rubric. Writes nothing.
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

jq -e --arg names "$names" --argjson exact "$exact" '
  ($names | split(" ")) as $allowed |
  type == "object" and
  ((keys - ["findings", "summary"]) | length == 0) and
  (.summary | type == "string") and
  (.findings | type == "array") and
  all(.findings[];
    type == "object" and
    ((keys - ["check", "result", "file", "line", "detail"]) | length == 0) and
    (.check | type == "string") and
    (.check as $c | $allowed | any(. == $c)) and
    (.result == "pass" or .result == "fail") and
    (.file | type == "string") and
    (.line | type == "number") and
    (.detail | type == "string")) and
  (if $exact == 1
   then ((.findings | map(.check) | sort) == ($allowed | sort))
   else true
   end)
' "$RESPONSE_FILE" > /dev/null
