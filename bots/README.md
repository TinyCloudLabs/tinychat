# Bots service

Tiny bots, slice 1 (TC-2808): each owner's Main bot is an OMP agent in its own gVisor sandbox. The TinyChat
backend calls this service; browsers never do. The interface is piece 1 of
[`docs/plans/tiny-bots-slice1.md`](../docs/plans/tiny-bots-slice1.md).

The service runs as its own Phala CVM with three containers (`docker-compose.phala.yml`), all from one image
except the ingress:

| Container | Privileges | Holds | Does |
| --- | --- | --- | --- |
| `bots-supervisor` | capability set below, no published port, no outbound network | `BOTS_SERVICE_SECRET` | internal API, starts and stops the sandboxes, talks to OMP over each sandbox's stdio |
| `bots-gateway` | unprivileged user, read-only, no capabilities | `REDPILL_API_KEY` | the only way out of a sandbox: one Unix socket per bot, forwards allowed model calls to `https://tee.redpill.ai` |
| `dstack-ingress` | the backend's ingress image | `CLOUDFLARE_API_TOKEN` (DNS for the certificate) | ends TLS inside the CVM, forwards to the supervisor |

Treat every sandbox as hostile: OMP has a shell, so each owner can run any code as root inside their sandbox.

## Internal API

All requests except `/healthz` need `Authorization: Bearer <BOTS_SERVICE_SECRET>` (constant-time compare) and
`X-TinyCloud-Owner: did:pkh:eip155:1:0x<40 lowercase hex>`, and the owner's address must be on this service's own
`BOTS_TEST_ACCOUNTS`. Anything else gets an empty 401.

- `POST /v1/bots/main/messages` `{ "text": "..." }` (1 to 8000 characters) streams `text/event-stream`:
  `status` (`starting` on a cold start, then `working`, repeated every 15 s while waiting), `delta` (assistant
  text), then exactly one `done` `{ messageId }` or `error` `{ code, message }`. One message at a time per bot; a
  second send gets `busy`. If the caller disconnects, the turn still finishes and lands in the history.
- `GET /v1/bots/main/messages` returns `{ messages: [{ id, role, text, at }] }`, newest last, at most 50. A bot
  that has never run answers `[]` without starting a sandbox; otherwise this starts the sandbox if it is stopped.
  A reply's `id` equals the `messageId` of its `done` event.
- `GET /healthz` returns `ok`.

Every event is encoded by the supervisor from checked fields; OMP output never passes through.

## How a message runs

1. The bot id is `sha256(owner DID)`. Every path is built from it, never from the DID.
2. On the first message (or the first after an idle stop) the supervisor mounts the bot's state filesystem,
   registers a fresh random token for the bot with the gateway, writes the OCI spec (from `runsc spec`) and runs
   `runsc run` in the foreground. Inside, `bot-start.sh` bridges `127.0.0.1:8080` to the egress socket and execs
   `omp --mode rpc --no-ui`; the sandbox's stdio is the RPC channel.
3. The supervisor waits for OMP's `ready`, sets the event filter (assistant deltas only), opens the session in
   `/root/bot/sessions/main`, sends the `prompt`, and maps `message_update` text deltas to `delta` and
   `prompt_result` to `done` / `error`.
4. After `session_settled` the bot stops once it has been idle for `BOTS_IDLE_MS`. The next message starts it again
   on the same session.

## Containment

Each sandbox:

- runs under gVisor (`--platform=systrap --network=none --host-uds=open`); its only way out is its own Unix socket
  at `/run/egress/egress.sock`, a read-only mount of a directory that holds nothing else;
- gets its own writable root layer in memory (`--overlay2=root:memory,size=BOTS_SANDBOX_OVERLAY_MB`) over one
  shared read-only bot rootfs, and a capped `/tmp` (`BOTS_SANDBOX_TMP_MB`); the host rootfs is never written;
- has its own cgroup: `BOTS_SANDBOX_MEMORY_MB`, `BOTS_SANDBOX_CPUS`, `BOTS_SANDBOX_PIDS`;
- keeps its state on its own fixed-size ext4 image (`BOTS_STATE_MB`, at `/data/bots/<bot id>/state.img`),
  loop-mounted only while it runs, so one bot cannot fill the disk.

RAM budget per running bot is `BOTS_SANDBOX_MEMORY_MB` (default 1536 MiB). It covers the processes and both in-memory
layers: the root layer and `/tmp` are held in sandbox memory and charged to its cgroup, so the supervisor refuses to
start unless memory exceeds overlay + tmp by at least 512 MiB. A bot that goes over is killed alone and reports
`bot_unavailable`. Size the CVM as (running bots) × `BOTS_SANDBOX_MEMORY_MB` plus about 1 GiB for the containers.

The gateway, per bot socket:

- accepts only that bot's current token (constant-time), and only `POST /v1/chat/completions` and `GET /v1/models`;
- rebuilds the chat body from an allowlist (`model`, `messages`, `stream`, `tools`, `tool_choice`, `temperature`,
  `stop`, `max_tokens` capped by `BOTS_MAX_TOKENS`); the model must be in `BOTS_MODELS`; it sets RedPill's ACI
  provider flag, turns provider fallbacks off and always asks for usage;
- sends to the fixed origin `https://tee.redpill.ai` with the model key, refuses redirects, and forwards only
  `content-type` back;
- enforces a 4 MiB request body, connect and total timeouts, an 8 MiB response cap, one request at a time per bot,
  a daily token budget per bot and a global daily cap, counted from reported usage (a stream cut short without
  usage is charged a conservative estimate);
- filters `/v1/models` to the allowlist.

OMP also probes `GET /models` and `GET /props` without a token at startup; the gateway refuses them and logs it.

## Configuration

Supervisor (`bots-supervisor`):

| Var | Default | |
| --- | --- | --- |
| `BOTS_SERVICE_SECRET` | required | unique 256-bit secret (at least 43 characters); `openssl rand -hex 32` |
| `BOTS_TEST_ACCOUNTS` | empty (nobody) | comma-separated addresses, or `*` |
| `BOTS_MODEL` | `z-ai/glm-5.2` | the backend's `REDPILL_DEFAULT_MODEL` default |
| `BOTS_IDLE_MS` | `600000` | idle time after `session_settled` before a sandbox stops |
| `BOTS_SANDBOX_MEMORY_MB` / `_CPUS` / `_PIDS` | `1536` / `1` / `256` | per-sandbox cgroup limits |
| `BOTS_SANDBOX_OVERLAY_MB` / `_TMP_MB` | `512` / `256` | root layer and `/tmp` caps (inside the memory limit) |
| `BOTS_STATE_MB` | `256` | state image size, fixed when a bot first runs |
| `PORT` | `8080` | |

Gateway (`bots-gateway`):

| Var | Default | |
| --- | --- | --- |
| `REDPILL_API_KEY` | required | a dedicated RedPill key with its own provider-side budget, not shared with main chat |
| `BOTS_MODELS` | `BOTS_MODEL` | comma-separated model allowlist |
| `BOTS_MAX_TOKENS` | `8192` | |
| `BOTS_BOT_DAILY_TOKENS` / `BOTS_GLOBAL_DAILY_TOKENS` | `2000000` / `20000000` | UTC day |
| `BOTS_MAX_BODY_BYTES` / `BOTS_MAX_RESPONSE_BYTES` | 4 MiB / 8 MiB | |
| `BOTS_UPSTREAM_CONNECT_TIMEOUT_MS` / `BOTS_UPSTREAM_TOTAL_TIMEOUT_MS` | `30000` / `600000` | |

`BOTS_TEST_UPSTREAM_URL` exists only for the local mock smoke: it must be a loopback `http://` URL, and the compose
file never passes it.

## Pinning

- gVisor release 20261102.0, sha512-checked in the Dockerfile.
- OMP `@oh-my-pi/pi-coding-agent@18.18.6` and every dependency from `sandbox/bun.lock`, installed with
  `bun install --frozen-lockfile`.
- The Bun base image by digest. The bot rootfs has no curl.
- In `docker-compose.phala.yml`, both images by digest, written into the file at deploy time.

## Why the supervisor has these capabilities

`runsc` needs `SYS_ADMIN`, `SYS_CHROOT`, `SETUID`, `SETGID`, `SETFCAP`, `DAC_OVERRIDE`, `DAC_READ_SEARCH`, `FOWNER`,
`FSETID`, `CHOWN`, `KILL`, `MKNOD`, with seccomp and AppArmor unconfined, to create a sandbox; this is the smallest
set that passed the local smoke (without `SETFCAP` the gofer fails with `fork/exec /proc/self/exe: operation not
permitted`). `/dev/loop-control` and block major 7 are for the state images. The supervisor remounts its cgroup2
namespace read-write (Docker mounts it read-only outside privileged mode) and moves itself into a leaf cgroup so
each sandbox can have its own limits; it refuses to start if that fails. If a CVM's Docker refuses these settings,
`privileged: true` in place of them also works, at the cost of the container getting every device and capability.

## Develop

```bash
cd bots
bun install             # standalone package: its own bun.lock, not a root workspace
bun test src            # unit tests
bun run build           # tsc --noEmit
DOCKER="sudo docker" PORT=28808 bun run smoke   # MOCK-model smoke, see below
```

`test/smoke.sh` builds the image and runs the real supervisor and gateway with gVisor, but with
`test/mock-upstream.ts` as the model (it always answers "pong"); the image never contains the mock. It shows the
SSE events for two owners, the busy rule, history, the idle stop and restart, and a containment checklist (two
sandboxes, egress and state isolation, caps, no network, no model key in a sandbox or the supervisor). Report its
result as a mock run. It removes everything it creates.

## Deploying (no workflow yet)

A deploy workflow, modelled on `.github/workflows/deploy-backend-phala.yml`, needs to:

1. Build `bots/` (context `bots/`, `linux/amd64`) and push `ghcr.io/tinycloudlabs/tinychat-bots`; reuse the
   backend's ingress image (`infra/phala-ingress`). Write both pushed digests over `BOTS_IMAGE_DIGEST` and
   `INGRESS_IMAGE_DIGEST` in `docker-compose.phala.yml`.
2. Deploy to a dedicated CVM (its own `PHALA_CVM_ID`, the same pinned dstack OS image as the backend) with
   encrypted envs `BOTS_SERVICE_SECRET`, `BOTS_TEST_ACCOUNTS`, `REDPILL_API_KEY` (dedicated key),
   `CLOUDFLARE_API_TOKEN`, `CERTBOT_EMAIL`, `PHALA_GATEWAY_CNAME`, `BOTS_INGRESS_DOMAIN`, plus any limit overrides,
   and sync `allowed_envs`. No other secrets belong in this CVM.
3. Point `BOTS_INGRESS_DOMAIN` (DNS CNAME to the Phala gateway) at the CVM, then probe
   `https://<BOTS_INGRESS_DOMAIN>/healthz` for `ok`.
4. Set the backend's `BOTS_SERVICE_URL=https://<BOTS_INGRESS_DOMAIN>`, the same `BOTS_SERVICE_SECRET`, and the
   same `BOTS_TEST_ACCOUNTS`.

## Limits of this slice

- Gateway budgets live in memory and reset when the gateway restarts; the provider-side budget on the dedicated key
  is the backstop.
- One upstream request at a time per bot: parallel model calls from one bot (for example subagents) get 429 and
  OMP retries them.
- The owner header is trusted from the backend (service secret only). Signed owner assertions and attestation checks
  come before general availability.
- A gateway restart drops registrations; the supervisor registers the bot again before every message.
