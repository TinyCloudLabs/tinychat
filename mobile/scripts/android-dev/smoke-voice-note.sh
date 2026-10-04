#!/usr/bin/env bash
# End-to-end voice-note smoke on the emulator (signed-in app, controller running):
#   record → inject a speech clip into the mic → stop → saved to TinyCloud → listed → the stored audio
#   (read back through the app's player) contains the speech. Prints PASS with numbers, or FAIL.
#   smoke-voice-note.sh [clip.wav]
# SMOKE_LIMIT_MS=15000: lower the recording limit for this run (the app's localStorage test override,
#   removed again on exit) and let the recorder stop ITSELF there instead of pressing Stop; also checks
#   the card says "Stopped at the 15-second limit." and the stored audio is no longer than the limit.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
cdp() { "$here/cdp.sh" eval "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# Read a value from cdp.sh output (a JSON value; JSON-encoded objects inside strings are unwrapped).
json() { python3 -c 'import json,sys; v=json.loads(sys.stdin.read()); v=json.loads(v) if isinstance(v,str) and v[:1] in "{[" else v; print(v'"$1"')'; }
clip=${1:-$EXO_STATE/speech.wav}
[ -f "$clip" ] || "$here/speech-sample.sh" "$clip"
$ADB shell pm grant xyz.tinycloud.exo android.permission.RECORD_AUDIO
$ADB shell pm grant xyz.tinycloud.exo android.permission.POST_NOTIFICATIONS 2>/dev/null || true

# Open Connectors → Sources and wait for the voice notes list to load.
ready=$(cdp 'new Promise(r => { let n = 0; const t = setInterval(() => { n++;
  if (location.pathname !== "/chat/connectors" && n % 10 === 1) { history.pushState({}, "", "/chat/connectors"); dispatchEvent(new PopStateEvent("popstate")); }
  const card = document.querySelector("[data-testid=voice-note-record]"), busy = document.querySelector("[data-testid=voice-note-stop]");
  if (((card || busy) && !/Loading your voice notes/.test(document.body.textContent)) || n > 400) { clearInterval(t);
    r(JSON.stringify({ ok: !!card, recording: !!busy, items: document.querySelectorAll("[data-testid=voice-note-item]").length, signedOut: /Sign in to start/.test(document.body.textContent) })); } }, 300); })')
# A cold start reads several TinyCloud tables one call at a time (2-4 s each), so allow ~2 minutes.
echo "$ready" | json '["ok"]' >/dev/null 2>&1 || fail "unexpected page state: $ready"
[ "$(echo "$ready" | json '["recording"]')" = "False" ] || fail "a recording is already in progress; stop it in the app first"
[ "$(echo "$ready" | json '["ok"]')" = "True" ] || fail "voice notes card not reachable (signed out? $ready)"
before=$(echo "$ready" | json '["items"]')

limit_ms=${SMOKE_LIMIT_MS:-}
if [ -n "$limit_ms" ]; then
  cdp 'localStorage.setItem("exo.voiceNotes.maxDurationMs", "'"$limit_ms"'"), "ok"' >/dev/null
  trap 'cdp "localStorage.removeItem(\"exo.voiceNotes.maxDurationMs\"), \"ok\"" >/dev/null 2>&1 || true' EXIT
fi

cdp 'document.querySelector("[data-testid=voice-note-record]").click(), "ok"' >/dev/null
state=$(cdp 'new Promise(r => { let n = 0; const t = setInterval(() => { n++; const s = document.querySelector("[data-testid=voice-note-status]");
  if (s?.dataset.micState === "recording" || n > 50) { clearInterval(t); r(s?.dataset.micState ?? "none"); } }, 200); })')
[ "$(echo "$state" | json '')" = "recording" ] || fail "recording did not start ($state)"
"$here/inject-audio.sh" "$clip"
# With SMOKE_LIMIT_MS the recorder stops itself at the limit; otherwise press Stop.
[ -n "$limit_ms" ] || cdp 'document.querySelector("[data-testid=voice-note-stop]").click(), "ok"' >/dev/null
saved=$(cdp 'new Promise(r => { let n = 0; const t = setInterval(() => { n++; const items = document.querySelectorAll("[data-testid=voice-note-item]");
  const pending = document.querySelector("[data-testid=voice-note-pending]"); const alert = [...document.querySelectorAll("[role=alert]")].map(a => a.textContent).find(t => /saving|voice note/i.test(t));
  if (items.length > '"$before"' || pending || alert || n > 400) { clearInterval(t);
    r(JSON.stringify({ items: items.length, pending: !!pending, alert: alert ?? null, newest: items[0]?.dataset.sourceId ?? null,
      limit: document.querySelector("[data-testid=voice-note-limit]")?.textContent ?? null })); } }, 300); })')
[ "$(echo "$saved" | json '["items"]')" -gt "$before" ] || fail "note not saved: $saved"
if [ -n "$limit_ms" ]; then
  echo "$saved" | json '["limit"]' | grep -q '^Stopped at the .* limit\.$' || fail "no limit notice after the auto-stop: $saved"
fi

# Read the stored audio back through the app's player (it is loaded from TinyCloud KV, part by part,
# into an object URL) and measure it: the page fetches its blob: URL and hands back base64.
b64=$(cdp 'new Promise(r => { document.querySelector("[data-testid=voice-note-item] button[aria-label=\"Play voice note\"]").click();
  let n = 0; const t = setInterval(async () => { n++; const a = document.querySelector("[data-testid=voice-note-player]");
  if (!a?.src && n <= 150) return; clearInterval(t); if (!a?.src) return r("");
  const bytes = new Uint8Array(await (await fetch(a.src)).arrayBuffer()); let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  r(btoa(s)); }, 200); })' | json '')
[ -n "$b64" ] || fail "stored audio did not load"
out=$EXO_STATE/smoke-note.m4a
echo "$b64" | base64 -d > "$out"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")
mean=$(ffmpeg -hide_banner -i "$out" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(-\?[0-9.]*\) dB.*/\1/p')
python3 -c "import sys; d, m = float('$dur'), float('$mean'); sys.exit(0 if d > 2 and m > -45 else 1)" \
  || fail "stored audio has no speech (duration ${dur}s, mean ${mean} dB)"
if [ -n "$limit_ms" ]; then
  python3 -c "import sys; sys.exit(0 if float('$dur') <= $limit_ms / 1000 + 1 else 1)" \
    || fail "auto-stopped audio is ${dur}s, longer than the ${limit_ms} ms limit"
fi
echo "PASS: saved note $(echo "$saved" | json '["newest"]') (${before} → $(echo "$saved" | json '["items"]') notes), stored audio ${dur}s, mean ${mean} dB${limit_ms:+, auto-stopped: $(echo "$saved" | json '["limit"]')}"
