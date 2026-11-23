#!/bin/sh
# PID 1 inside a bot sandbox (gVisor, --network=none). Bridges the loopback port OMP calls to the bot's egress
# socket (mounted read-only at /run/egress), then becomes OMP in RPC mode: its stdin/stdout are the supervisor's
# channel, so nothing else may write to stdout.
# BOT_SYSTEM_PROMPT is the bot's own prompt file (Main's or a sibling's), chosen by the supervisor. Without it, or if
# the file is missing (OMP would take the path itself as the prompt), OMP finds the role-neutral
# /root/.omp/agent/SYSTEM.md instead.
# BOT_NAME is the name the owner sees for the bot (TC-3790). It replaces {{botName}} in the prompt, every character of
# it literal, in a copy under TMPDIR: the prompt file itself is read-only.
set -eu
socat TCP-LISTEN:8080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/egress/egress.sock </dev/null >/dev/null &
if [ -f "${BOT_SYSTEM_PROMPT:-}" ]; then
  prompt="${TMPDIR:-/tmp}/system-prompt.md"
  BOT_NAME="${BOT_NAME:-TrustBot}" awk 'BEGIN { name = ENVIRON["BOT_NAME"]; tag = "{{botName}}" }
    { out = ""; rest = $0
      while ((at = index(rest, tag)) > 0) { out = out substr(rest, 1, at - 1) name; rest = substr(rest, at + length(tag)) }
      print out rest }' "$BOT_SYSTEM_PROMPT" > "$prompt"
  exec omp --mode rpc --no-ui --system-prompt "$prompt"
fi
exec omp --mode rpc --no-ui
