#!/usr/bin/env bash
# Reads the operator credential row count (GET /api/internal/credential-row-count?source=<source>) and prints ONE line:
#   source=<source> http=<status> count=<integer|unavailable> [code=<CODE>]
# The key reaches curl on stdin, never on a command line, and is never printed. The response body is matched against the
# two shapes the route returns and only digits and a fixed upper-case code are printed from it, so nothing else the
# server sends can reach the log. Exit 0 only for a 200 with an integer count.
#
# Environment: CREDENTIAL_COUNT_ADMIN_KEY (required), API_URL (https, default https://api.tinycloud.chat), SOURCE (default fireflies).
set -u +x

source_name="${SOURCE:-fireflies}"
api_url="${API_URL:-https://api.tinycloud.chat}"
key="${CREDENTIAL_COUNT_ADMIN_KEY:-}"

if [[ ! "$source_name" =~ ^[a-z0-9-]{1,32}$ ]]; then
  echo "source=invalid"
  exit 1
fi
# Localhost over http is for the test of this script only; any real target is https.
if [[ "$api_url" != https://* && "$api_url" != http://127.0.0.1:* ]]; then
  echo "source=$source_name api_url=refused"
  exit 1
fi
if [[ -z "$key" ]]; then
  echo "source=$source_name key=missing"
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
# curl --config reads the header from stdin; backslash and quote are escaped for its config syntax.
escaped="${key//\\/\\\\}"
escaped="${escaped//\"/\\\"}"
status="$(printf 'header = "x-admin-key: %s"\n' "$escaped" | curl --config - --silent --output "$body" --write-out '%{http_code}' --max-time 20 --max-redirs 0 "${api_url%/}/api/internal/credential-row-count?source=${source_name}" 2>/dev/null)" || status="000"
[[ "$status" =~ ^[0-9]{3}$ ]] || status="000"

count="unavailable"
code=""
response="$(tr -d '\r\n' < "$body" 2>/dev/null | head -c 512)"
if [[ "$response" =~ ^\{\"source\":\"[a-z0-9-]{1,32}\",\"count\":([0-9]{1,15})\}$ ]]; then
  count="${BASH_REMATCH[1]}"
elif [[ "$response" =~ ^\{\"source\":\"[a-z0-9-]{1,32}\",\"count\":null,\"code\":\"([A-Z_]{1,32})\"\}$ ]]; then
  code="${BASH_REMATCH[1]}"
fi

line="source=$source_name http=$status count=$count"
[[ -n "$code" ]] && line="$line code=$code"
echo "$line"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$line" >> "$GITHUB_STEP_SUMMARY"
fi
[[ "$status" == "200" && "$count" != "unavailable" ]]
