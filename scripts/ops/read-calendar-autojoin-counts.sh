#!/usr/bin/env bash
# Reads the calendar auto-join connection counts (GET /api/internal/calendar-autojoin-counts, TC-916) and prints ONE line:
#   http=<status> connections=<n> enabled=<n> email_scope=<n> verified_email=<n> needing_reconnect=<n>
# or `http=<status> counts=unavailable`. The key reaches curl on stdin, never on a command line, and is never printed.
# The response body must match the route's exact shape and only its digits are printed, so nothing else the server
# sends can reach the log. Exit 0 only for a 200 with the five counts.
#
# Environment: CREDENTIAL_COUNT_ADMIN_KEY (required), API_URL (https, default https://api.tinycloud.chat).
set -u +x

api_url="${API_URL:-https://api.tinycloud.chat}"
key="${CREDENTIAL_COUNT_ADMIN_KEY:-}"

# Localhost over http is for the test of this script only; any real target is https.
if [[ "$api_url" != https://* && "$api_url" != http://127.0.0.1:* ]]; then
  echo "api_url=refused"
  exit 1
fi
if [[ -z "$key" ]]; then
  echo "key=missing"
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
# curl --config reads the header from stdin; backslash and quote are escaped for its config syntax.
escaped="${key//\\/\\\\}"
escaped="${escaped//\"/\\\"}"
status="$(printf 'header = "x-admin-key: %s"\n' "$escaped" | curl --config - --silent --output "$body" --write-out '%{http_code}' --max-time 20 --max-redirs 0 "${api_url%/}/api/internal/calendar-autojoin-counts" 2>/dev/null)" || status="000"
[[ "$status" =~ ^[0-9]{3}$ ]] || status="000"

n='([0-9]{1,9})'
shape="^\{\"connections\":$n,\"enabled\":$n,\"enabled_with_email_scope_granted\":$n,\"enabled_with_verified_email\":$n,\"enabled_needing_reconnect\":$n\}$"
response="$(tr -d '\r\n' < "$body" 2>/dev/null | head -c 512)"
line="http=$status counts=unavailable"
ok=1
if [[ "$status" == "200" && "$response" =~ $shape ]]; then
  line="http=$status connections=${BASH_REMATCH[1]} enabled=${BASH_REMATCH[2]} email_scope=${BASH_REMATCH[3]} verified_email=${BASH_REMATCH[4]} needing_reconnect=${BASH_REMATCH[5]}"
  ok=0
fi
echo "$line"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$line" >> "$GITHUB_STEP_SUMMARY"
fi
exit "$ok"
