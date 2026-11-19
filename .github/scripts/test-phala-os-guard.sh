#!/usr/bin/env bash
# Tests phala-os-guard.sh with CVM metadata: no network, no Phala account.
# Usage: test-phala-os-guard.sh   (from anywhere)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="${here}/phala-os-guard.sh"
root="$(mktemp -d -p "${TMPDIR:-/var/tmp}")"
trap 'rm -rf "${root}"' EXIT
mkdir "${root}/bin"
# Refuse network access, including when checking the pre-change guard.
printf '#!/usr/bin/env bash\nexit 1\n' >"${root}/bin/curl"
chmod +x "${root}/bin/curl"

PROD_NAME=dstack-0.5.12
PROD_HASH=8db40cb23008d6213668b5816702d100b37b859a8a5bfd18d938ae3a1b3715bd
DEV_NAME=dstack-dev-0.5.12
DEV_HASH=e866e987221db357129ebc3f066b6706ef955889ea95e5510acbdf3d3055186b
OTHER_HASH="$(printf 'a%.0s' {1..64})"

os_json() { # <is_dev> <name> <hash>
  jq -nc --argjson dev "$1" --arg name "$2" --arg hash "$3" \
    '{name: "cvm", os: {is_dev: $dev, name: $name, os_image_hash: $hash}}'
}
os_json_with_nul() { # <is_dev> <name-or-nul> <hash-or-nul>
  jq -nc --argjson dev "$1" --arg name "$2" --arg hash "$3" \
    '{name: "cvm", os: {is_dev: $dev, name: (if $name == "nul" then (if $dev then "dstack-dev-0.5.12" else "dstack-0.5.12" end) + "\u0000" else $name end), os_image_hash: (if $hash == "nul" then (if $dev then "e866e987221db357129ebc3f066b6706ef955889ea95e5510acbdf3d3055186b" else "8db40cb23008d6213668b5816702d100b37b859a8a5bfd18d938ae3a1b3715bd" end) + "\u0000" else $hash end)}}'
}


failures=0
# run <cvm-json> [VAR=value ...]: feed metadata exactly as the workflow does.
run() {
  local cvm="$1"; shift
  set +e
  out="$(env -i PATH="${root}/bin:/usr/bin:/bin" \
    PHALA_OS_IMAGE="${PROD_NAME}" PHALA_OS_IMAGE_HASH="${PROD_HASH}" \
    GITHUB_EVENT_NAME=workflow_dispatch GITHUB_STEP_SUMMARY="${root}/summary" \
    "$@" bash "${guard}" <<<"${cvm}" 2>&1)"
  code=$?
  set -e
}
expect() { # <name> <exit code> <output regex>
  if [ "${code}" != "$2" ] || ! grep -Eq -- "$3" <<<"${out}"; then
    echo "FAIL: $1 (exit ${code}, wanted $2 matching /$3/)"
    printf '    %s\n' "${out}"
    failures=$((failures + 1))
  else
    echo "ok: $1"
  fi
}
run "$(os_json false "${PROD_NAME}" "${PROD_HASH}" | jq -c '.os.name += "\n"')"
expect "production name with trailing LF is refused" 1 "not on the production OS image"
run "$(os_json false "${PROD_NAME}" "${PROD_HASH}" | jq -c '.os.os_image_hash += "\n"')"
expect "production hash with trailing LF is refused" 1 "not on the production OS image"
run "$(os_json_with_nul false nul "${PROD_HASH}")"
expect "production name with embedded NUL is refused" 1 "not on the production OS image"
run "$(os_json_with_nul false "${PROD_NAME}" nul)"
expect "production hash with embedded NUL is refused" 1 "not on the production OS image"
run "$(os_json false "${PROD_NAME} " "${PROD_HASH}")"
expect "production name with trailing space is refused" 1 "not on the production OS image"
run "$(os_json false "${PROD_NAME}x" "${PROD_HASH}")"
expect "production name with suffix is refused" 1 "not on the production OS image"
run "$(os_json false "${PROD_NAME}" "${PROD_HASH}a")"
expect "production hash with extra hex is refused" 1 "not on the production OS image"

run "$(os_json true "${DEV_NAME}" "${DEV_HASH}" | jq -c '.os.name += "\n"')" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "transition name with trailing LF is refused" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json true "${DEV_NAME}" "${DEV_HASH}" | jq -c '.os.os_image_hash += "\n"')" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "transition hash with trailing LF is refused" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json_with_nul true nul "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "transition name with embedded NUL is refused" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json_with_nul true "${DEV_NAME}" nul)" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "transition hash with embedded NUL is refused" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json true "${DEV_NAME} " "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "transition name with trailing space is refused" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json true "${DEV_NAME}x" "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "transition name with suffix is refused" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json true "${DEV_NAME}" "${DEV_HASH}a")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "transition hash with extra hex is refused" 1 "not the recorded TC-2843 dev OS image"

run "$(os_json false "${PROD_NAME}" "${PROD_HASH}")"
expect "production image passes" 0 "runs the production OS image"
run "$(os_json false "${PROD_NAME}" "${OTHER_HASH}")"
expect "a non-pinned production hash is refused" 1 "not on the production OS image"
run "$(os_json false other-production-image "${PROD_HASH}")"
expect "a non-pinned production name is refused" 1 "not on the production OS image"

run "$(os_json true "${DEV_NAME}" "${DEV_HASH}")"
expect "the recorded dev image is refused by default" 1 "dev OS.*refused"
run "$(os_json true "${DEV_NAME}" "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=false
expect "an explicit false refuses the recorded dev image" 1 "dev OS.*refused"
run "$(os_json true "${DEV_NAME}" "${OTHER_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "the transition input cannot permit another dev hash" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json true other-dev-image "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "the transition input cannot permit another dev name" 1 "not the recorded TC-2843 dev OS image"
run "$(os_json true "${DEV_NAME}" "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "the exact recorded dev image passes only with a loud transition warning" 0 "::warning::TC-2843.*${DEV_NAME}.*${DEV_HASH}.*allow_current_dev_os_until_tc2843=true"
grep -Eq "TC-2843.*${DEV_NAME}.*${DEV_HASH}" "${root}/summary" 2>/dev/null || {
  echo "FAIL: transition warning missing from run summary"
  failures=$((failures + 1))
}
for event in push schedule workflow_call; do
  run "$(os_json true "${DEV_NAME}" "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true GITHUB_EVENT_NAME="${event}"
  expect "${event} cannot enable the transition override" 1 "override requires workflow_dispatch"
done
run "$(os_json false "${PROD_NAME}" "${PROD_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true GITHUB_EVENT_NAME=push
expect "a non-manual override is refused even on production" 1 "override requires workflow_dispatch"
run "$(os_json true "${DEV_NAME}" "${DEV_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=TRUE
expect "a non-boolean override cannot permit dev" 1 "dev OS.*refused"
run "$(os_json false "${PROD_NAME}" "${OTHER_HASH}")" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "the transition input cannot bypass the production pin" 1 "not on the production OS image"
run "$(os_json true "${DEV_NAME}" UPPERCASE-OR-SHORT)" ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "a malformed dev hash is refused even with the transition input" 1 "not the recorded TC-2843 dev OS image"

run '{"name":"cvm","os":{"name":"dstack-dev-0.5.12","os_image_hash":"'"${DEV_HASH}"'"}}'
expect "a missing is_dev is refused" 1 "missing is_dev"
run '{"name":"cvm","os":{"is_dev":true,"name":"dstack-dev-0.5.12"}}' ALLOW_CURRENT_DEV_OS_UNTIL_TC2843=true
expect "a missing hash is refused even with the transition input" 1 "missing is_dev, name or os_image_hash"
run '{"name":"cvm"}'
expect "a missing os object is refused" 1 "missing is_dev"
run '{"name":"cvm","os":{"is_dev":"false","name":"'"${PROD_NAME}"'","os_image_hash":"'"${PROD_HASH}"'"}}'
expect "a string is_dev is refused" 1 "missing is_dev"
run 'not json'
expect "unparsable Phala output is refused" 1 "Cannot read the OS"
run ''
expect "empty Phala output is refused" 1 "missing is_dev"

[ "${failures}" = 0 ] || { echo "${failures} failure(s)"; exit 1; }
echo "all phala-os-guard tests passed"
