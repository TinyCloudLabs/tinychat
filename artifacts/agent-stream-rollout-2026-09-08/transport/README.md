# Transport policy evidence — 2026-09-08

Recommended bounded-canary settings: `AGENT_STREAM_HEARTBEAT_MS=10000`,
`AGENT_STREAM_TURN_TIMEOUT_MS=300000`, `AGENT_STREAM_DRAIN_GRACE_MS=5000`.
The heartbeat is supported by the pinned-ingress experiment below. The five-minute
turn limit is an operational resource/UX choice, not a measured provider latency
SLO. Five seconds gives ample terminal-flush allowance relative to the previously
recorded local 0–3.2 ms DONE-to-EOF timings while keeping nonreaders bounded. These
values require a production-path canary before claiming production validation.

## Measured local pinned ingress

`pinned-ingress-probe.py` ran in the exact upstream image used by TinyChat's ingress
Dockerfile, with Docker networking disabled. It extracted the shipped generated
server template and nginx root configuration, replacing only local host, ports,
certificate paths, and the include path. Both requests used local synthetic bytes,
TLS, and `X-Accel-Buffering: no`. This is nginx 1.27.4, **not a production test**.

- Immediate comment followed by silence: `IncompleteRead` at **60,218.43 ms**;
  no DONE or successful HTTP EOF.
- Immediate comment followed by 10-second comments: **8 comments**, maximum gap
  **10,005.70 ms**; one DONE at **75,152.21 ms**, actual HTTP EOF at **75,160.08 ms**,
  no read error.
- Assertions passed; exit 0. Owned container stopped and removed itself.
- Full numeric output and image/source hashes: `pinned-ingress-results.json`.

This supports leaving ingress unchanged: the existing response header allows
comments to traverse this exact image. Against the measured local approximately
60-second boundary, 10 seconds gives six scheduled opportunities, and
`3 * 10000 + 6000 = 36000 < 60000` reserves extra scheduling margin. The experiment
does not measure production delivery jitter or prove the historical incident cause.

Reproduce from the TinyChat worktree root:

```sh
docker run --rm --network none --read-only --platform linux/amd64 \
  --tmpfs /tmp --tmpfs /var/cache/nginx --tmpfs /var/run --tmpfs /var/log/nginx \
  --volume "$PWD/artifacts/agent-stream-rollout-2026-09-08/transport/pinned-ingress-probe.py:/probe.py:ro" \
  --entrypoint python3 \
  dstacktee/dstack-ingress@sha256:40429d78060ef3066b5f93676bf3ba7c2e9ac47d4648440febfdda558aed4b32 \
  /probe.py
```

## Current production observations

Read-only observations were taken approximately 2026-09-08 15:24–15:33 UTC.

- Remote main: `abdab6c3db7665a3c7f43a3ad4122ca9a31972e0`; PR 67:
  `5e6550f52ff5c4075767e103eb3d06e5b0fee17b`, mergeable at observation time.
- [Phala run 34209232597](https://github.com/TinyCloudLabs/tinychat/actions/runs/34209232597)
  succeeded at main; the Cloudflare Pages check reports deployment
  `f312f6f5-6cab-4679-a8e7-3d8ab79ac232` at that same SHA. Desktop run 34209232602
  also succeeded at that SHA.
- Provisioned `phala ps tinychat-backend --json`, filtered before output, reports
  both containers running, created `1788859264`, up six hours.
- Backend tag: `ghcr.io/tinycloudlabs/tinychat-backend:abdab6c3db7665a3c7f43a3ad4122ca9a31972e0`;
  runtime image ID `sha256:8fd97864442f3727ac40f0a2c12279c0db36fa93f28eb4ac8b200402e1243e68`.
- Ingress tag: `ghcr.io/tinycloudlabs/tinychat-backend:ingress-abdab6c3db7665a3c7f43a3ad4122ca9a31972e0`;
  runtime image ID `sha256:a592e0c6a7b5f509eb8f8eb394140d53bf84cadfc4bc1fe6a61e4605b47fc8b0`.
- `/health` 200 over HTTP/2; `/api/server-info` 200 with `status=ready`;
  unauthenticated `/api/agent/session` 401. These were single bounded probes.
- Public API DNS returns a Phala CNAME and A address 66.220.6.105, consistent with
  the checked-in DNS-only setup. Cloudflare zone configuration was not queried.
- Live compose structural audit found no nginx/scripts config mounts and no
  service entrypoint/command/config overrides. The pre-launch script is present,
  with no nginx/ingress/proxy-timeout keywords; this keyword check does not prove
  script semantics. Sanitized hashes and booleans: `deployment-structure.json`.
- The provisioned runtime-config API exposes gateway-domain/host/SSH settings,
  not effective nginx or gateway idle/absolute caps; values were not printed.

The main SHA is the **candidate** recovery baseline. Reconfirm these identities,
health, protected-config equality, and restart counts immediately before rollout.
The old `04c63069...` baseline is stale. Current observation does not independently
prove Pages' custom-domain active deployment or container restart-count stability.

## Authoritative interpretation

The image has no proxy timeout overrides. Nginx documents a default 60-second
[proxy read timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)
between reads, and a default 60-second
[downstream send timeout](https://nginx.org/en/docs/http/ngx_http_core_module.html#send_timeout).
These are inactivity timers, not whole-turn caps. The explicit keepalive timeout
of 65 seconds concerns idle reusable connections, not an active streamed response.
Nginx's [buffering documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)
explains that `X-Accel-Buffering: no` disables response buffering unless ignored;
the pinned template has no such ignore override.

Phala documents [TLS passthrough](https://docs.phala.com/phala-cloud/networking/tls-passthrough)
for custom-domain ingress, without specifying this deployment's effective idle
or absolute cap. Current upstream
[gateway source](https://github.com/Dstack-TEE/dstack/blob/1544d337816585e335ba1baccfaa4fa404353f4e/dstack/gateway/gateway.toml#L147)
has a ten-minute data-idle default. That source version/configuration has not
been tied to this production gateway and must not be presented as its setting.

## Bounded production-path acceptance

Use the exact candidate backend image and frontend SHA, with synthetic provider
and tool data through the actual public ingress path in an isolated canary seat.
Do not replace global provider configuration or send private meeting queries.
Freeze a sequential request count and at-most-11-minute execution budget:

1. One success with four intentionally silent phases (initial model, tool,
   synthesis, citation repair), 65 seconds each, ending around 260 seconds. Each
   comment must actually arrive at the external client; record arrival timestamps,
   maximum gap, comment count, one DONE, and real HTTP EOF after DONE. A 20-second
   maximum observed comment gap is the canary acceptance threshold, not a measured
   production SLO. Require the first comment within two seconds of SSE headers.
2. One permanently stalled provider turn: comments continue, a typed timeout
   occurs at approximately 300 seconds, reachable upstream work is aborted, no
   successful receipt is emitted, and HTTP termination settles within the five-
   second drain allowance plus a separately recorded transport measurement margin.
3. One Stop after partial synthetic output, then one fresh success: the stopped
   provider request aborts, no replay occurs, and the composer remains usable.
4. In actual Safari, exercise Stop and an incomplete-stream failure followed by
   a new successful submission. Verify partial text preservation, cleared activity,
   usable composer, no false successful receipt, no unhandled rejection. Local
   Chrome or an embedded WebKit implementation does not substitute for Safari.

The raw consumer must continue reading after DONE to establish real HTTP EOF;
TinyChat's product parser intentionally cancels its reader at DONE. Retain only
timings, counts, booleans, fixed failure classes, and exact deployment identities.
Do not log request/response content or credentials. Stop this canary on a transport
failure; retain the failing evidence and investigate before a general rollout.
