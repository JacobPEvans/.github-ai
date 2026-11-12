#!/usr/bin/env bash
# Router refusals, gateway and budget failures are not review findings. A job that hits
# one says so four ways: a job-summary line, an annotation, a neutral check run on the
# head commit with the reason in its output, and an optional ntfy ops alert. A blocking
# or required caller still fails closed; the check run itself always stays neutral.
#
#   gateway-failure.sh classify <file|->      print the reason class, or nothing
#   gateway-failure.sh truncated <file>       print truncated when a verdict file is cut off
#   gateway-failure.sh report <job> <class>   write the four signals; exit 1 when failed
#
# A verdict cut off by the output limit is reported as "AI review output truncated", never as a
# gateway failure. classify does not name it: its input is a log, and callers that read logs keep
# failing on a length finish reason as before.
#
# report reads:
#   CONCLUSION        neutral (default) or failure (blocking or required; job exit only)
#   GITHUB_TOKEN      Claude bot App installation token with checks: write, minted by
#                     the caller. The callee's own GITHUB_TOKEN is never used for this.
#   CHECK_TOKEN_CAUSE why no token exists (key not set, mint failed); named in the error
#   CHECK_HEAD_SHA    commit the check run attaches to (required)
#   CHECK_APP_SLUG    app slug used to select an existing check run (optional)
#   CHECK_NAME        optional: overrides the default check-run name
#   CHECK_SUMMARY     optional: overrides the check-run summary
#   GITHUB_REPOSITORY owner/repo, set by the runner
#   NTFY_BASE_URL     optional: the alert is skipped when unset
#   RUN_URL           optional: appended to the alert body
#
# Exit status: 1 when the check run cannot be created (a 403 or other API error, or
# no token on a blocking or required caller), and 1 whenever CONCLUSION is failure.
# A missing grant never looks green. An advisory caller (CONCLUSION=neutral) with no
# token warns and exits 0: the summary, annotation and ops alert still carry the reason.
set -euo pipefail

classify() {
  local text
  text="$(cat -- "$1")"
  if grep -Eqi 'Budget (has been|limit) exceeded' <<< "$text"; then
    echo budget-exceeded
  elif grep -Eqi 'No fallback model group (was )?found' <<< "$text"; then
    echo no-fallback-model
  elif grep -Eqi '(^|[^0-9])429([^0-9]|$)|too many requests|rate.?limit' <<< "$text"; then
    echo rate-limited
  elif grep -Eqi 'ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection (error|refused|reset)|socket hang up|fetch failed' <<< "$text"; then
    echo connection
  elif grep -Eqi 'APITimeoutError|Request timed out|litellm\.Timeout' <<< "$text"; then
    echo timeout
  elif grep -Eqi 'BadGatewayError|ServiceUnavailableError|Bad Gateway|Service Unavailable|Gateway Time-?out|Error code: 50[234]' <<< "$text"; then
    echo gateway-error
  elif grep -Eqi 'Failed to authenticate\. API Error: 40[13]([^0-9]|$)|litellm\.(AuthenticationError|PermissionDeniedError)' <<< "$text"; then
    echo router-refused
  fi
}

# A non-empty verdict cut off by the output limit: an unterminated JSON document or a completion
# whose finish reason is length. Other invalid JSON and schema failures remain invalid responses.
verdict_truncated() {
  local parse_error
  if [ ! -s "$1" ]; then
    return 0
  elif parse_error="$(jq empty "$1" 2>&1)"; then
    if jq -e '(.choices[0].finish_reason // .finish_reason) == "length"' "$1" > /dev/null 2>&1; then
      echo truncated
    fi
  elif grep -Eqi 'Unfinished .* at EOF|Unfinished JSON term at EOF|Unexpected end of JSON input' <<< "$parse_error"; then
    echo truncated
  fi
}

create_check() {
  local job="$1" reason="$2" conclusion="$3" summary check_name response
  if [ -z "${GITHUB_TOKEN:-}" ]; then
    if [ "$conclusion" = failure ]; then
      echo "::error::$job: cannot post the check run: no Claude bot App token (${CHECK_TOKEN_CAUSE:-unknown cause})"
      return 1
    fi
    # Advisory: the summary, annotation and ops alert already carry the reason.
    echo "::warning::$job: cannot post the check run: no Claude bot App token (${CHECK_TOKEN_CAUSE:-unknown cause})"
    return 0
  fi
  if [ -z "${CHECK_HEAD_SHA:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then
    echo "::error::$job: cannot post the check run; CHECK_HEAD_SHA and GITHUB_REPOSITORY must be set"
    return 1
  fi
  if [[ ${CHECK_SUMMARY+x} ]]; then
    summary="$CHECK_SUMMARY"
  elif [ "$reason" = truncated-response ] || [ "$reason" = truncated ]; then
    summary="AI review reply was truncated at the completion ceiling"
  else
    summary="gateway unavailable ($reason)"
  fi
  check_name="${CHECK_NAME:-$job: AI review not performed}"
  if response="$(GH_TOKEN="$GITHUB_TOKEN" \
    GITHUB_REPOSITORY="$GITHUB_REPOSITORY" \
    CHECK_HEAD_SHA="$CHECK_HEAD_SHA" \
    CHECK_APP_SLUG="${CHECK_APP_SLUG:-}" \
    bash "$(dirname -- "${BASH_SOURCE[0]}")/check-run.sh" \
      upsert "$check_name" neutral "AI review not performed" "$summary" 2>&1)"; then
    if [ -n "$response" ]; then
      printf '%s\n' "$response"
    fi
    return 0
  fi
  if grep -qiE 'HTTP 403|not accessible by integration' <<< "$response"; then
    echo "::error::$job: the check run was refused with 403. The Claude bot App needs checks: write on this repository and must be installed on it."
  else
    echo "::error::$job: the check run could not be created: $(head -c 300 <<< "$response")"
  fi
  return 1
}

send_alert() {
  local job="$1" line="$2" host
  if [ -z "${NTFY_BASE_URL:-}" ]; then
    echo "NTFY_BASE_URL not configured; skipping the ops alert."
    return 0
  fi
  echo "::add-mask::$NTFY_BASE_URL"
  host="${NTFY_BASE_URL#*://}"
  host="${host%%/*}"
  if [ -n "$host" ]; then
    echo "::add-mask::$host"
    echo "::add-mask::${host%%:*}"
  fi
  curl -sS --max-time 30 -X POST "${NTFY_BASE_URL%/}/ai" \
    -H "Title: $job: AI review not performed" \
    --data "$line${RUN_URL:+ $RUN_URL}" \
    || echo "::warning::ops alert not delivered"
  return 0
}

report() {
  local job="$1" reason="$2" line cause conclusion="${CONCLUSION:-neutral}" check_status=0
  if [ "$reason" = truncated-response ] || [ "$reason" = truncated ]; then
    line="AI review reply was truncated at the completion ceiling"
    cause="a truncated verdict"
  else
    line="AI review not performed: gateway unavailable ($reason)"
    cause="a gateway failure"
  fi
  printf '%s\n' "$line" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
  if [ "$conclusion" = failure ]; then
    echo "::error::$job: $line"
  else
    echo "::warning::$job: $line"
  fi

  create_check "$job" "$reason" "$conclusion" || check_status=$?
  send_alert "$job" "$line"
  if [ "$check_status" -ne 0 ]; then
    return "$check_status"
  fi
  if [ "$conclusion" = failure ]; then
    echo "::error::$job is blocking or required; failing closed on $cause."
    return 1
  fi
  return 0
}

case "${1:-}" in
  classify) classify "${2:--}" ;;
  truncated) verdict_truncated "${2:?verdict file is required}" ;;
  report) report "${2:?job name is required}" "${3:?reason class is required}" ;;
  *)
    echo "usage: gateway-failure.sh classify <file|-> | truncated <file> | report <job> <class>" >&2
    exit 2
    ;;
esac
