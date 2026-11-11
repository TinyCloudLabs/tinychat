#!/usr/bin/env bash
# Phala deploy guard: require the pinned production OS image by default.
# TC-2843 transition only: an explicit manual dispatch may permit the exact recorded dev image.
#
# Usage:  phala cvms get <cvm> --json | bash phala-os-guard.sh
# Env:    PHALA_OS_IMAGE, PHALA_OS_IMAGE_HASH   required production image name and hash
#         ALLOW_CURRENT_DEV_OS_UNTIL_TC2843     default false; only literal true enables the exception
#         GITHUB_EVENT_NAME                   must be workflow_dispatch for the exception
#         GITHUB_STEP_SUMMARY                 run summary path (set by Actions)
#
# Fails closed on missing/malformed fields or any unpinned OS tuple. Never changes the OS.
set -euo pipefail

fail() {
  echo "::error::$*"
  exit 1
}

: "${PHALA_OS_IMAGE:?PHALA_OS_IMAGE is not set}"
: "${PHALA_OS_IMAGE_HASH:?PHALA_OS_IMAGE_HASH is not set}"
allow_dev="${ALLOW_CURRENT_DEV_OS_UNTIL_TC2843:-false}"
if [ "${allow_dev}" = true ] && [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ]; then
  fail "TC-2843 override requires workflow_dispatch"
fi

cvm="$(cat)"
os="$(jq -c '.os' <<<"${cvm}" 2>/dev/null)" || fail "Cannot read the OS of the CVM from the Phala output"
field() {
  jq -r --arg key "$1" --arg type "$2" \
    'if type == "object" and (.[$key] | type) == $type then .[$key] | tostring else "" end' <<<"${os}"
}
is_dev="$(field is_dev boolean)"
name="$(field name string)"
hash="$(field os_image_hash string)"
if [ -z "${is_dev}" ] || [ -z "${name}" ] || [ -z "${hash}" ]; then
  fail "The CVM OS is missing is_dev, name or os_image_hash. Found: ${os}"
fi

if [ "${is_dev}" = "false" ]; then
  if [ "${name}" != "${PHALA_OS_IMAGE}" ] || [ "${hash}" != "${PHALA_OS_IMAGE_HASH}" ]; then
    fail "The CVM is not on the production OS image ${PHALA_OS_IMAGE} (${PHALA_OS_IMAGE_HASH}). Found: ${os}"
  fi
  echo "The CVM runs the production OS image ${name}"
  exit 0
fi

[ "${allow_dev}" = true ] || fail "The dev OS image ${name} (${hash}) is refused; production OS is required by default (TC-2843)"
if [ "${name}" != dstack-dev-0.5.12 ] || [ "${hash}" != e866e987221db357129ebc3f066b6706ef955889ea95e5510acbdf3d3055186b ]; then
  fail "The CVM is not the recorded TC-2843 dev OS image. Found: ${os}"
fi
warning="TC-2843: permitting DEV OS ${name} (${hash}) ONLY because allow_current_dev_os_until_tc2843=true was explicitly selected for this manual dispatch. This is NOT a production OS; remove this input with the OS move or first post-move deploy."
echo "::warning::${warning}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '\n> **WARNING: %s**\n' "${warning}" >>"${GITHUB_STEP_SUMMARY}"
fi
