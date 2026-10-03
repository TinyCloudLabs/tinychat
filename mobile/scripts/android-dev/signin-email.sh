#!/usr/bin/env bash
# Sign in to Exo with OpenKey's email code, as a throwaway mailinator test account:
#   EXO_TEST_EMAIL=<name>@mailinator.com signin-email.sh
# Taps are coordinates for the Pixel 7 AVD (1080x2400): the OpenKey sheet is a cross-origin iframe,
# so it is driven like a user. Needs the controller (cdp.sh start). Never use a real account here:
# mailinator inboxes are public.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
email=${EXO_TEST_EMAIL:?set EXO_TEST_EMAIL to a throwaway <name>@mailinator.com account}
"$here/cdp.sh" eval '(() => { const b = [...document.querySelectorAll("button")].filter(e => /^(sign in|try again)$/i.test(e.textContent.trim())).pop(); b?.click(); return b ? "clicked" : "no sign-in button"; })()'
sleep 8
$ADB shell input tap 540 1825; sleep 3                     # Continue with email
$ADB shell input text "$email"; sleep 1
$ADB shell input tap 540 1227; sent=$(date -u +%s); sleep 4 # Send code
code=$(python3 "$here/mailinator-otp.py" "${email%@*}" "$sent")
$ADB shell input text "$code"; unset code; sleep 1
$ADB shell input tap 540 1394; sleep 14                    # Verify and continue
for _ in 1 2 3; do $ADB shell input swipe 540 2100 540 700 300; sleep 0.7; done
$ADB shell input tap 540 1942                               # Approve capabilities
sleep 15
"$here/cdp.sh" eval 'JSON.stringify({path: location.pathname, signedIn: !/Sign in to start/.test(document.body.innerText)})'
