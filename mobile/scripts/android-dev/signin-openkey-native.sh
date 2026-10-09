#!/usr/bin/env bash
# Sign in to Exo through the NATIVE OpenKey delegation flow (TC-775 E1, gate L1):
# the app opens the authorize URL in a Chrome Custom Tab, OpenKey signs in there
# (email + code from a throwaway mailinator inbox), the consent page approves the
# TinyCloud delegation, and the tab returns to the app on
# xyz.tinycloud.exo://openkey/callback. Ends on the app's signed-in check, the
# same probe signin-email.sh uses. Then smoke-voice-note.sh runs unchanged.
#
#   EXO_TEST_EMAIL=<name>@mailinator.com signin-openkey-native.sh
#
# Needs: the emulator up (start-emulator.sh), the app built with
# VITE_EXO_NATIVE_OPENKEY=true and the native client id, the app installed and
# launched (launch-app.sh), and the controller running (cdp.sh start).
# Taps are coordinates for the Pixel 7 AVD (1080x2400), like signin-email.sh —
# the Custom Tab is Chrome UI, not the WebView, so it is driven like a user.
# Never use a real account here: mailinator inboxes are public.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
email=${EXO_TEST_EMAIL:?set EXO_TEST_EMAIL to a throwaway <name>@mailinator.com account}
cdp() { "$here/cdp.sh" eval "$1"; }

# The app's own sign-in button. The sheet opens in a Custom Tab — the WebView
# keeps showing the sign-in screen until the deep link returns.
cdp '(() => { const b = [...document.querySelectorAll("button")].filter(e => /^(sign in|try again)$/i.test(e.textContent.trim())).pop(); b?.click(); return b ? "clicked" : "no sign-in button"; })()'
sleep 12   # PAR + the OpenKey login page inside the Custom Tab

# OpenKey login in Chrome: email entry, code, consent. Chrome's DOM is not
# reachable over the WebView DevTools socket, so the tab is driven with taps.
$ADB shell input tap 540 1825; sleep 3                     # Continue with email
$ADB shell input text "$email"; sleep 1
$ADB shell input tap 540 1227; sent=$(date -u +%s); sleep 4 # Send code
code=$(python3 "$here/mailinator-otp.py" "${email%@*}" "$sent")
$ADB shell input text "$code"; unset code; sleep 1
$ADB shell input tap 540 1394; sleep 14                    # Verify and continue

# The consent screen: scroll so the approve button is in reach, then approve
# the delegation (the screen lists the applications-space KV/SQL entries).
for _ in 1 2 3; do $ADB shell input swipe 540 2100 540 700 300; sleep 0.7; done
$ADB shell input tap 540 1942                              # Approve
sleep 15                                                   # code exchange → deep link back to Exo

# Back in the WebView: TinyCloud restore + backend verify, then the app is ready.
cdp 'JSON.stringify({path: location.pathname, signedIn: !/Sign in to start/.test(document.body.innerText)})'
