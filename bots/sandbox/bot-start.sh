#!/bin/sh
# PID 1 inside a bot sandbox (gVisor, --network=none). Bridges the loopback port OMP calls to the bot's egress
# socket (mounted read-only at /run/egress), then becomes OMP in RPC mode: its stdin/stdout are the supervisor's
# channel, so nothing else may write to stdout.
# BOT_SYSTEM_PROMPT is the bot's own prompt file (Main's or a sibling's), chosen by the supervisor. Without it, or if
# the file is missing (OMP would take the path itself as the prompt), OMP finds the role-neutral
# /root/.omp/agent/SYSTEM.md instead.
set -eu
socat TCP-LISTEN:8080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/egress/egress.sock </dev/null >/dev/null &
if [ -f "${BOT_SYSTEM_PROMPT:-}" ]; then exec omp --mode rpc --no-ui --system-prompt "$BOT_SYSTEM_PROMPT"; fi
exec omp --mode rpc --no-ui
