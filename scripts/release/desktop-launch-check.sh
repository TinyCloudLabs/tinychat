#!/usr/bin/env bash
# Release gate for a built desktop (TinyCloud One) app (TC-4459): launches the packaged .app on a macOS runner and exits 1
# unless it opens, stays up, shows its window, and the bundled web view renders the page with the release's own version
# line. The page is the bundled one (tauri://localhost), so no network, sign-in or secret is involved: the app starts
# signed out and the check reads the screen, not the app's data.
#
# Signals, all from outside the app:
#   - Info.plist: short version and build number are the release's, so the bundle that opens is the one that ships.
#   - Signed releases: codesign (deep, strict), a stapled ticket and a Gatekeeper assessment of the bundle that opens.
#   - The process is the bundle's executable, stays alive, and owns an on-screen standard window titled like the app.
#   - A screenshot of the screen read by on-device text recognition (desktop-launch-observe.swift) shows the build line the
#     page renders ("<version> (<build number>)"). A blank or crashed web view never shows it.
# Usage: desktop-launch-check.sh <app.zip> <version> <build number> <signed|unsigned> [work dir]
set -euo pipefail

usage='usage: desktop-launch-check.sh <app.zip> <version> <build number> <signed|unsigned> [work dir]'
zip=${1:?$usage}
version=${2:?$usage}
build=${3:?$usage}
mode=${4:?$usage}
work=${5:-$(mktemp -d)}
here=$(cd "$(dirname "$0")" && pwd)
# From launch to verdict; the job's own limit is longer.
budget=${EXO_LAUNCH_CHECK_SECONDS:-90}

fail() {
  echo "::error::$1"
  exit 1
}

case "$mode" in signed | unsigned) ;; *) fail "mode is '$mode', expected signed or unsigned" ;; esac
[ -f "$zip" ] || fail "no archive at $zip"
case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) fail "version '$version' is not X.Y.Z" ;; esac
case "$build" in '' | *[!0-9]*) fail "build number '$build' is not digits" ;; esac

mkdir -p "$work"
ditto -x -k "$zip" "$work/app"
apps=("$work"/app/*.app)
[ "${#apps[@]}" -eq 1 ] && [ -d "${apps[0]}" ] || fail "expected one .app in $zip"
app=${apps[0]}
plist="$app/Contents/Info.plist"

field() {
  plutil -extract "$1" raw "$plist"
}

# The marketing version is numeric: a beta X.Y.Z-beta.N ships as X.Y.Z.
core=${version%%-*}
[ "$(field CFBundleShortVersionString)" = "$core" ] || fail "CFBundleShortVersionString is '$(field CFBundleShortVersionString)', expected '$core'"
[ "$(field CFBundleVersion)" = "$build" ] || fail "CFBundleVersion is '$(field CFBundleVersion)', expected '$build'"
exe=$(field CFBundleExecutable)
name=$(field CFBundleName 2>/dev/null || basename "$app" .app)
echo "ok: bundle $(field CFBundleIdentifier) $core ($build), executable $exe, window title '$name'"

if [ "$mode" = signed ]; then
  codesign --verify --deep --strict --verbose=2 "$app" || fail "codesign --verify --deep --strict failed for $app"
  xcrun stapler validate "$app" || fail "no valid stapled notarization ticket on $app"
  spctl --assess --type execute -vvv "$app" || fail "Gatekeeper rejects $app"
  echo "ok: signature, stapled ticket and Gatekeeper accept the app that opens"
fi

pid=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

diagnose() {
  echo "--- diagnostics (no sign-in, no secrets)"
  lsappinfo list 2>&1 | grep -i -A3 -F "$name" | head -30 || true
  if [ -f "$work/observed.txt" ]; then sed -n 1,60p "$work/observed.txt"; fi
  log show --last 3m --style compact --predicate "process == \"$exe\" AND (eventMessage CONTAINS 'didFail' OR eventMessage CONTAINS 'crash' OR eventMessage CONTAINS 'terminat')" 2>&1 | tail -15 | cut -c1-220 || true
}

open -n "$app" || fail "the system could not open $app"
start=$SECONDS
while [ -z "$pid" ]; do
  pid=$(pgrep -nf -- "$app/Contents/MacOS/" || true)
  [ -n "$pid" ] && break
  [ $((SECONDS - start)) -lt 30 ] || fail "the app did not start within 30 s"
  sleep 1
done
echo "ok: started as pid $pid after $((SECONDS - start)) s"

# Spaces and punctuation vary in recognized text; the digits and dots of the version and the build number do not.
verdict=""
while [ $((SECONDS - start)) -lt "$budget" ]; do
  kill -0 "$pid" 2>/dev/null || { diagnose; fail "the app exited within $((SECONDS - start)) s of launch"; }
  if screencapture -x "$work/screen.png" 2>"$work/screencapture.err"; then
    swift "$here/desktop-launch-observe.swift" "$pid" "$work/screen.png" >"$work/observed.txt" 2>"$work/observe.err" || true
    window=false
    grep -q -F "window layer=0 " "$work/observed.txt" && grep -F "window layer=0 " "$work/observed.txt" | grep -q -F "name=$name" && window=true
    line=$(grep '^text ' "$work/observed.txt" | tr -d ' ' | grep -E -- "${core//./\\.}.*\\(?${build}\\)?" | head -1 || true)
    if [ "$window" = true ] && [ -n "$line" ]; then
      verdict=ok
      echo "ok: on-screen window '$name'; the page shows: ${line#text}"
      break
    fi
  else
    echo "screencapture failed: $(cat "$work/screencapture.err")"
  fi
  sleep 3
done

if [ "$verdict" != ok ]; then
  diagnose
  if [ -s "$work/observe.err" ]; then sed -n 1,10p "$work/observe.err"; fi
  fail "within $budget s the app did not show an on-screen '$name' window with the build line '$core ($build)'"
fi

kill -0 "$pid" 2>/dev/null || fail "the app exited after it rendered"
echo "ok: $name $core ($build) launched, rendered its bundled page and stayed up ($((SECONDS - start)) s)"
