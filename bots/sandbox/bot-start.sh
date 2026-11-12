#!/bin/sh
# PID 1 inside a bot sandbox (gVisor, --network=none). Bridges the loopback port OMP calls to the bot's egress
# socket (mounted read-only at /run/egress), then becomes OMP in RPC mode: its stdin/stdout are the supervisor's
# channel, so nothing else may write to stdout.
set -eu
socat TCP-LISTEN:8080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/egress/egress.sock </dev/null >/dev/null &
exec omp --mode rpc --no-ui
