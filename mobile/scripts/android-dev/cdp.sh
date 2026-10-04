#!/usr/bin/env bash
# cdp.sh start                 start the controller (background; log in $EXO_STATE/ctl.log)
# cdp.sh eval '<js>'           evaluate in the WebView, print the JSON result (waits up to 60s)
# cdp.sh cdp <Method> '{json}' send a raw CDP command
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
mkdir -p "$EXO_STATE/cmd" "$EXO_STATE/out"
case "${1:?usage: cdp.sh start|eval|cdp}" in
  start)
    pid_file=$EXO_STATE/ctl.pid
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then kill "$(cat "$pid_file")"; fi
    rm -f "$EXO_STATE"/cmd/* "$EXO_STATE"/out/*
    EXO_STATE=$EXO_STATE EXO_DEVTOOLS_PORT=$EXO_DEVTOOLS_PORT setsid nohup node "$here/cdp-ctl.mjs" > "$EXO_STATE/ctl.log" 2>&1 < /dev/null &
    echo $! > "$pid_file"
    for _ in $(seq 1 40); do grep -q " ready " "$EXO_STATE/ctl.log" 2>/dev/null && { echo "controller ready"; exit 0; }; sleep 0.5; done
    echo "cdp.sh: controller did not start; see $EXO_STATE/ctl.log" >&2; exit 1 ;;
  eval) body=$(python3 -c 'import json,sys;print(json.dumps({"eval":sys.argv[1]}))' "${2:?js}") ;;
  cdp)  body=$(python3 -c 'import json,sys;print(json.dumps({"cdp":sys.argv[1],"params":json.loads(sys.argv[2])}))' "${2:?method}" "${3:-{\}}") ;;
  *) echo "usage: cdp.sh start|eval|cdp" >&2; exit 2 ;;
esac
n=$(date +%s%N)
printf '%s' "$body" > "$EXO_STATE/cmd/$n.tmp" && mv "$EXO_STATE/cmd/$n.tmp" "$EXO_STATE/cmd/$n.json"
for _ in $(seq 1 240); do
  if [ -f "$EXO_STATE/out/$n.txt" ]; then cat "$EXO_STATE/out/$n.txt"; echo; rm -f "$EXO_STATE/out/$n.txt"; exit 0; fi
  sleep 0.25
done
echo "cdp.sh: timed out" >&2; exit 1
