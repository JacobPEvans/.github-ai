#!/usr/bin/env bash
# Validate a rubric verdict before anything renders it. Exits 0 when RESPONSE_FILE is a
# verdict whose check names belong to RUBRIC, 1 when it is not, 2 for an unknown rubric.
# Writes nothing. Accepts exactly the keys the renderer reads: summary and findings, and per
# finding check, result, file, line and detail.
set -euo pipefail

: "${RUBRIC:?RUBRIC is required}"
: "${RESPONSE_FILE:?RESPONSE_FILE is required}"

case "$RUBRIC" in
  policy) checks='dry|native_first|disclosure|missing_test|token_budget' ;;
  security) checks='auth|injection|permission_widening|unsafe_trigger|secret_handling' ;;
  leak) checks='credential|private_host_or_ip|internal_topology|incident_detail' ;;
  semantic) checks='claim_mismatch|omitted_behavior' ;;
  *) echo "::error::Unknown rubric: $RUBRIC" >&2; exit 2 ;;
esac

jq -e --arg checks "$checks" '
  type == "object" and
  ((keys - ["findings", "summary"]) | length == 0) and
  (.summary | type == "string") and
  (.findings | type == "array") and
  all(.findings[];
    type == "object" and
    ((keys - ["check", "result", "file", "line", "detail"]) | length == 0) and
    (.check | type == "string" and test("^(" + $checks + ")$")) and
    (.result == "pass" or .result == "fail") and
    (.file | type == "string") and
    (.line | type == "number") and
    (.detail | type == "string"))
' "$RESPONSE_FILE" > /dev/null
