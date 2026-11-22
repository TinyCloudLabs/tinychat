# Bots service

Tiny bots, slice 1 (TC-2808): each owner's Main bot is an OMP agent in its own gVisor sandbox. The TinyChat
backend calls this service; browsers never do. The interface is piece 1 of
[`docs/plans/tiny-bots-slice1.md`](../docs/plans/tiny-bots-slice1.md).

The service runs as its own Phala CVM with three containers (`docker-compose.phala.yml`), all from one image
except the ingress:

| Container | Privileges | Holds | Does |
| --- | --- | --- | --- |
| `bots-supervisor` | capability set below, no published port, no outbound network | `BOTS_SERVICE_SECRET` | internal API, starts and stops the sandboxes, talks to OMP over each sandbox's stdio |
| `bots-gateway` | unprivileged user, read-only, no capabilities | `REDPILL_API_KEY` | one Unix socket per bot for allowed model calls and a control socket for bot admission |
| `dstack-ingress` | the backend's ingress image | `CLOUDFLARE_API_TOKEN` (DNS for the certificate) | ends TLS inside the CVM, forwards to the supervisor |

Treat every sandbox as hostile: OMP has a shell, so each owner can run any code as root inside their sandbox.

## Internal API

All requests except `/healthz` are signed by the backend (`src/signed-call.ts`; the backend's copy is
`backend/src/bots-signed-call.ts`), and the owner's address must be on this service's own `BOTS_TEST_ACCOUNTS`.
Anything else gets an empty 401.

- `POST /v1/bots/main/messages` `{ "text": "..." }` (1 to 8000 characters) streams `text/event-stream`:
  `status` (`starting` on a cold start, then `working`, repeated every 15 s while waiting), `delta` (assistant
  text), then exactly one `done` `{ messageId }` or `error` `{ code, message }`. One message at a time per bot; a
  second send gets `busy`. If the caller disconnects, the turn still finishes and lands in the history. A reply
  longer than `BOTS_MAX_TURN_BYTES` is cut off (the agent's turn is aborted, the stream ends with
  `bot_unavailable`); a turn with no result within `BOTS_TURN_TIMEOUT_MS` ends the same way and its sandbox is
  killed. A caller that stops reading gets its stream dropped once 1 MiB is queued, instead of buffering more.
- `GET /v1/bots/main/messages` returns `{ messages: [{ id, role, text, at }] }`, newest last, at most 50. A bot
  that has never run answers `[]` without starting a sandbox; otherwise this starts the sandbox if it is stopped.
  A reply's `id` equals the `messageId` of its `done` event.
- `GET /healthz` returns `ok`.

### More than one bot per owner

An owner's bots are named by a key: `main`, or the 32 lower-case hex characters the backend chose when it created
the bot. Everything above also exists at `/v1/bots/<key>/...`. A key of any other form gets 404 before anything is
built from it.

The backend's registry decides which bots exist. This service keeps its own copy, one file per owner on the data
volume (`/data/bots/owners/<sha256(owner DID)>.json`, never mounted into a sandbox), and checks it before a request
for a sibling may create anything. `main` exists without being announced; a sibling exists only once announced.

- `PUT /v1/bots/<key>` `{ "state": "active" | "suspended" | "deleting", "seq": <integer> }` announces a bot's state
  and answers `{ "state": <the state now held> }`. `seq` is the registry's counter: an update with a `seq` at or below
  the one held is ignored, and so is anything after `deleting`. `main` cannot be set to `deleting`.
  A bot this service has not seen before is refused with `409 { "error": "owner_bot_limit" }` when its owner already
  has `BOTS_MAX_PER_OWNER` bots here, `main` included. Bots that are `deleting` or gone are not counted, a bot first
  announced as `deleting` is not refused, and an update to a bot already held is never refused.
- `DELETE /v1/bots/<key>` deletes the working state of a bot that is `deleting` and answers
  `{ "outcome": "gone" }`, `{ "outcome": "waiting", "cause": "archive_pending" | "closing" | "gateway_cleanup_pending" }`
  or `{ "outcome": "failed", "cause": ... }`. Once gone, the bot is `removed` for good, and a
  request that was still waiting on the deletion is refused (503) instead of starting the bot again.

| | active | suspended | deleting | unknown or removed |
| --- | --- | --- | --- | --- |
| `POST .../messages` | yes | 409 | 409 | 404 |
| `GET .../messages` | yes | yes | 409 | 404 |
| `.../history`, `/history/stage`, `/history/notice`, `/history/permission` | yes | yes | yes | 404 |

A permission update for a sibling that has never run creates no journal and no directory.

Every event is encoded by the supervisor from checked fields; OMP output never passes through.

## How a message runs

1. The bot id is `sha256(owner DID)` for `main`, and `sha256(owner DID + "\n" + key)` for a sibling. Every path is
   built from it, never from the DID or the key.
2. On the first message (or the first after an idle stop) the supervisor mounts a fresh tmpfs for the bot's state,
   restores the bot's saved state into it, registers a fresh random token for the bot with the gateway, writes the
   OCI spec (from `runsc spec`) and runs `runsc run` in the foreground. Inside, `bot-start.sh` bridges
   `127.0.0.1:8080` to the egress socket and execs `omp --mode rpc --no-ui --system-prompt <file>`; the sandbox's stdio
   is the RPC channel. The file is Main's or the sibling prompt (`sandbox/prompts/main.md`, `sibling.md`, copied to
   `/opt/tinycloud/prompts`); the sibling prompt is also the image's `/root/.omp/agent/SYSTEM.md`, which OMP reads if
   the file is missing.
3. The supervisor waits for OMP's `ready`, sets the event filter (assistant deltas only), opens the session in
   `/root/bot/sessions/main`, sends the `prompt`, and maps `message_update` text deltas to `delta` and
   `prompt_result` to `done` / `error`. A prompt the owner did not write (one bot messaging another) starts with the
   line "[TinyCloud: this message is from another of the owner's bots, not from the owner.]", so it never starts
   with "/" and cannot run an OMP slash command.
4. OMP's own settings (`config.yml`, written by the supervisor) keep read, write, edit, bash, glob and grep and turn
   off its other built-in tools, subagents, background jobs and skills.
5. After `session_settled` the supervisor saves the bot's state to disk, and the bot stops once it has been idle for
   `BOTS_IDLE_MS`. The next message starts it again on the same session.

## Working state

Each bot's working state, its state snapshot, stays on the bots server and is deleted after `BOTS_RETENTION_DAYS` days
(default 30) without use. Every message and history request records the bot's last use in
`/data/bots/<bot id>/last-used`, next to the state snapshot and outside anything the sandbox mounts; a bot without that
file counts from the snapshot's modification time. The supervisor checks every bot directory in `/data/bots` (symlinks
are skipped) at startup and every 6 hours, and skips a bot with a request in flight.

Deleting goes through one path. It stops the bot's sandbox (unmounting its state snapshot) and then checks that the
teardown and gateway cleanup succeeded, that `/data/bots/<bot id>` and `/run/bots/<bot id>` are real directories directly
under their roots, that nothing is mounted at or under either (`/proc/self/mountinfo`). If all hold, it removes both directories and logs `state_deleted`. Otherwise it removes
nothing and logs `state_delete_skipped` with the cause. The backend retries explicit deletes while the bot is
`deleting`, and the next supervisor sweep retries retention deletes. A message arriving during a retention deletion
waits, then starts a fresh bot. Once shutdown begins, deletion is refused, including a deletion still waiting for teardown.

The supervisor creates data and run roots with mode 0700 and refuses roots that are symlinks, owned by another user, or writable by group or others.

## Containment

Each sandbox:

- runs under gVisor (`--platform=systrap --network=none --host-uds=open`); its only way out is its own Unix socket
  at `/run/egress/egress.sock`, a read-only mount of a directory that holds nothing else;
- gets its own writable root layer in memory (`--overlay2=root:memory,size=BOTS_SANDBOX_OVERLAY_MB`) over one
  shared read-only bot rootfs, and a capped `/tmp` (`BOTS_SANDBOX_TMP_MB`); the host rootfs is never written;
- has its own cgroup: `BOTS_SANDBOX_MEMORY_MB`, `BOTS_SANDBOX_CPUS`, `BOTS_SANDBOX_PIDS`;
- keeps its state (`/root/bot`) in its own tmpfs while it runs: `BOTS_STATE_MB` in size, with room for 64 files and
  directories per MiB, mounted nosuid, nodev and noexec (it holds the bot's sessions; nothing runs from it).

RAM budget per running bot is `BOTS_SANDBOX_MEMORY_MB` (default 1536 MiB). It covers the processes and the three
in-memory layers: the root layer, `/tmp` and the state the bot writes are held in memory and charged to its cgroup,
so the supervisor refuses to start unless memory exceeds overlay + tmp + state by at least 512 MiB. A bot that goes
over is killed alone and reports `bot_unavailable`.

All sandboxes together sit under one parent cgroup (`/bots`) capped at `BOTS_TOTAL_MEMORY_MB` (default 6144) and
`BOTS_TOTAL_PIDS` (default 2048). A restore writes the bot's saved state from a leaf of that parent
(`/bots/restore`), outside the bot's own cgroup, so each running bot counts there as `BOTS_SANDBOX_MEMORY_MB +
BOTS_STATE_MB`. `BOTS_MAX_RUNNING` caps how many bots run at once (default `BOTS_TOTAL_MEMORY_MB /
(BOTS_SANDBOX_MEMORY_MB + BOTS_STATE_MB)`, 3); the supervisor refuses to start if that many would not fit, and a
message that would start a bot past the cap gets `at_capacity` (it is not queued and spends nothing; a history request gets `bot_unavailable`). A bot whose last stop was
not confirmed (see Saved state) keeps its place until its next start confirms the end. The whole supervisor
container sits at `mem_limit: 7g` in the compose, so many bots cannot starve the gateway or the ingress. Size the CVM
as the supervisor's `mem_limit` plus about 1 GiB.

The supervisor runs in its own cgroup namespace (`cgroup: private`) and refuses to start unless `/proc/self/cgroup`
reads `0::/`, so the cgroup tree it writes is the container's own.

The gateway, per bot socket:

- accepts only that bot's current token (constant-time), and only `POST /v1/chat/completions` and `GET /v1/models`;
- holds one request slot per bot, taken before the body is read: a second request while one runs, or a bot over
  budget, is refused without reading its body, so a bot cannot pile up bodies to exhaust the gateway's memory;
- reads the body against `BOTS_BODY_TIMEOUT_MS` (default 30 s) and a 4 MiB cap; before a request is accepted,
  Bun's idle timeout (10 s without a byte) also cuts slow headers and bodies;
- rebuilds the chat body from an allowlist: `model` (must be in `BOTS_MODELS`), `messages` (each rebuilt to `role`
  plus string or text-part `content`, `tool_calls` and `tool_call_id`; images, cache hints and everything else are
  dropped), `stream`, `tools` (rebuilt to `type: "function"` with `name`, `description`, `parameters`),
  `tool_choice`, `temperature`, `stop`, and `max_tokens`; it sets RedPill's ACI provider flag, turns provider
  fallbacks off and always asks for usage;
- sends to the fixed origin `https://tee.redpill.ai` with the model key, refuses redirects, and forwards only
  `content-type` back;
- enforces connect and total timeouts, an 8 MiB response cap, a daily token budget per bot, a daily total for all of
  one owner's bots, and a global daily cap. The supervisor names a bot's owner when it registers the bot; the map of
  bots to owners is kept beside the budget file (`owners.json`) and saved the same way, and if it cannot be saved the
  gateway answers 503 until it can.
  Bots calling at once cannot overshoot either: a prompt whose estimate (bytes / 3) does not fit what is
  left is refused, `max_tokens` is capped by `BOTS_MAX_TOKENS` and by what is left, and the whole estimate (prompt
  plus `max_tokens`) is reserved against both budgets before the call. When the call ends the reservation is settled
  to the reported usage and the unused part released (a stream cut short without usage keeps the whole
  reservation; an upstream error releases it);
- keeps the budget counters on its own volume (`bot-budget`, `/var/lib/bots-gateway/budget.json`), so a restart,
  including one a bot provokes, does not reset them. Each save is a temporary file, fsynced, renamed into place,
  then the directory fsynced. If a save fails (disk full, read-only volume, any error) the gateway stops serving
  model calls, answering 503 to every bot, until a later save succeeds; it retries on each request. A budget file
  that exists but cannot be read stops the gateway from starting (see below);
- filters `/v1/models` to the allowlist.

OMP also probes `GET /models` and `GET /props` without a token at startup; the gateway refuses them and logs it.

### Web access

Main can use the web only when its owner turns it on: in Main's chat, tap Web access and choose `off` (the default),
`listed` (only the owner's sites, subdomains included) or `any` public site. Turning it on shows this warning first:

> A web page can hide instructions meant for an AI. Main might follow them and put things you've told it into a search or a web address. Searches go to our search provider, Tavily. Our server fetches pages, so the sites see our server, not you. Don't open or paste links Main gives you unless you trust them.
>
> This setting lets Main open pages you've never seen, and any of them could try this. "Only sites you list" is safer, but anyone who can post on those sites could still try it.

The setting is saved by the supervisor in `/data/bots/<bot id>/web.json` and given to the gateway before each message;
the gateway applies it on every call. A missing or unreadable file reads as `off`.

- Main's OMP has two MCP servers on the egress socket (bot token required): `web`, the gateway's `POST /v1/mcp`, and
  `app` (see Questions from Main). The `web` tools, `search` and `fetch`, reach OMP as `mcp__web_search` and `mcp__web_fetch`; OMP's own web tools are off.
- A search goes to the search provider (Tavily Search; `BOTS_TEST_WEB_URL` is a loopback mock for tests). Without
  `TAVILY_API_KEY` a search answers "isn't available".
- A page is read by the `bots-fetch` container (`src/fetch-main.ts`, `POST /fetch {"url", "hosts"}`), which reads pages
  without a key (`BOTS_TEST_FETCH_URL` is a loopback mock for tests). It cannot read PDFs or pages that need JavaScript.
- Page HTML becomes plain text (`src/page-text.ts`) before Main sees it.
- Daily budgets per bot and for all bots, and the call timeout, are set with the `BOTS_WEB_*` variables below.
- The log and the saved counts hold counts by tool and outcome only.

### Questions from Main

Main can ask its owner one short question and carry on; the answer comes back later as a new message. It ships off:
the owner turns it on in Main's settings, and until then Main has no tool for it and every call is refused. This is
the `ask_owner` tool of the `app` MCP server.

- The `app` server is the gateway's `POST /v1/mcp/app` on the egress socket (bot token required), beside `web`. A
  sandbox's `mcp.json` is written once and always lists both, so the setting is not in it: the gateway lists
  `ask_owner` only while the setting is on and refuses every `tools/call` while it is off (`tools/list` is then empty).
  OMP lists a server's tools when the sandbox starts, so a running Main sees a change of the setting at its next
  start; the gateway applies the setting on every call either way.
- `ask_owner { question, choices? }` takes a question of 1 to 280 characters and up to 4 choices of up to 60. It is
  plain text: control, direction and other format characters are removed and whitespace collapses, and a longer text is
  refused rather than shortened. It answers `{ id, state: "pending" }` at once and nothing else. Refusals are fixed
  sentences that never repeat what the model or the owner wrote.
- Limits, applied by the gateway from counts the supervisor pushes: 3 open questions and 10 a day (UTC), for the
  bot and for its owner; a question the owner said not now to is refused for an hour (compared after dropping
  punctuation, collapsing whitespace and lowercasing, so rewording by punctuation does not get past it; any other
  question is still allowed). A question left unanswered for 24 hours expires.
- The owner's setting is `/data/bots/<bot id>/asks.json` and the requests are `/data/bots/<bot id>/requests.json`, in
  the data directory beside `web.json`. Neither is under `state/`, which is what gets copied into a sandbox, and no
  sandbox mount is the data directory or inside it. Their only link to the box is the gateway. A missing setting, or
  one saved without `enabled`, reads as off (the default); only a saved `true` is on. An unreadable or malformed one
  also reads as off and is logged (`asks_setting_unreadable`).
- The gateway cannot call the supervisor (separate containers), so it holds a validated new question in memory until
  the supervisor collects it over the control socket: `POST /bots/<id>/asks/drain` answers `{ asks, outside }`, and
  `PUT /bots/<id>/asks` gives the setting, the counts and the declined hashes. The supervisor does this at sandbox
  launch, at the start and end of each message, when the owner lists requests and after each decision. A question the
  box asked that the supervisor has not collected is lost if the gateway restarts.
- Turning the setting off (`PUT /asks { enabled: false }`, which is also what stopping Main from asking does) closes
  every pending question at once: it becomes `stopped` with `undelivered: true` and its question and choices are
  deleted from `requests.json` at that moment, so nothing about it is listed or can come back when the setting is
  turned on again. Main is told once per switch-off, not once per request, with the `stopped` sentence below: the
  requests one switch-off stopped share a time, and when the app sends the reply for any of them (`appReply` does not
  need the setting on) all of them are marked told together, so the others get 409 `no_reply`. A request stopped by a
  later switch-off is a separate message. A switch-off not told is dropped after the usual 12 hours, all together.
  A stopped request is not an answer and not a decline: no one-hour cooldown is recorded for its question. Requests
  already answered, declined or expired are not touched. A question the gateway took but the supervisor had not
  collected is dropped, never stored: the supervisor collects nothing into the records while the setting is off, the
  off push empties the gateway's hold, and
  the closing waits for any collection under way (they run one at a time per bot), so nothing becomes pending after
  the off. The closing does not depend on the gateway: if the gateway cannot be told, the setting is still off and it
  is told at the next sync.
- Each request has `outside`: true when anything from outside the owner's own words has reached Main's conversation
  before it was asked: a `search` or `fetch` call, a message relayed from another bot, or a reply from another bot to
  Main's own message. It is a warning for the owner, not a block, and it is sticky: the conversation persists, so a page
  read in one turn can steer a question in a later one. The supervisor keeps it as `outsideSeen` in `asks.json`, learns
  of web calls when it collects from the gateway (`{ asks, outside }`, also just before a sandbox stops, while the
  gateway still holds them) and gives it to the gateway with every push; the gateway only ever turns it on. Only
  resetting the bot's working state, which removes its data directory, clears it. A web call the gateway saw and the
  supervisor had not yet collected is lost if the gateway restarts before then.
- Routes, Main only (any other bot: 404; a service without them answers 404, which the backend passes on):
  - `GET` and `PUT /v1/bots/main/asks`: `{ enabled }`.
  - `GET /v1/bots/main/requests`: `{ requests: [{ id, kind: "ask", state, askedAt, expiresAt, outside, resolvedAt?,
    question?, choices?, answer?, undelivered? }] }` (times are ISO 8601). `state` is `pending`, `answered`,
    `declined`, `stopped` or `expired`. `question` and `choices` are there only while pending. `undelivered` is `true`
    for an answered, declined or stopped request until Main has been told, and `answer` is there only then (answered).
  - `POST /v1/bots/main/requests/<id>/answer`: `{ "decision": "decline" }`, `{ "decision": "answer", "answer": "..." }`
    (1 to 280 characters) or `{ "decision": "answer", "choice": 0 }`. 400 `{ error: "invalid" }`; 409
    `{ error: "not_pending" }` for a request that is not pending, expired or not the owner's.
  - `POST /v1/bots/main/messages` `{ "appReply": { "requestId": "..." } }` delivers the decision to Main. Only the id
    is read: the service composes the text from what it stored, and a `text` or `from` in the body is ignored. 409
    `{ error: "no_reply" }` when the request is not decided, already delivered, expired or not the owner's.
- What Main is told, in a message from the app: `The person answered your question: <answer>` for an answer,
  `The person chose not to answer now. Carry on without it, and don’t ask again unless they bring it up.` for a
  decline and `The person turned off questions from you, so your open questions were closed without an answer. Carry
  on without asking.` for a question closed by turning the setting off (each is one constant in `asks.ts`,
  `ASK_REPLIES`, and the words are pending approval). An expired question sends nothing. Only this route writes such
  a message (`from: "app"` inside the service, never taken from a request), so the text is always the composed one,
  and it teaches the bot no addresses. Its history line carries `origin: "app"` and
  `decision: "answered" | "declined" | "stopped"`, which `GET /v1/bots/main/messages` returns. This works with the
  history journal; the fallback that lists OMP's own session cannot mark them.
- Retention: a question's text is deleted when it is decided or expires. An answer's text is deleted when Main has
  been told (the turn reached `done`) or 12 hours after the decision if it was not, whichever is first; a turn that
  does not finish leaves it to send again. Metadata (id, state, times, `outside`) is kept for 7 days, at most 200
  requests, for the counts. A sweep every 15 minutes applies this even when nobody opens the chat.
- The log holds counts by outcome (`{gateway:"asks", tool:"ask_owner", outcome}`) and the owner's decision outcome,
  never a question, a choice, an answer or a request id.

### Saved state

The supervisor saves each bot's tmpfs to `/data/bots/<bot id>/state`: when a turn settles, with the sandbox paused
(`runsc pause` … `runsc resume`) for the copy, and on every stop, once the sandbox is confirmed gone and before the
tmpfs is unmounted. A start restores that copy into the fresh tmpfs before the sandbox starts. Every copy runs in its
own process, is killed past `BOTS_STATE_COPY_TIMEOUT_MS` (cause `timeout`; a paused sandbox is resumed), and:

- looks up every name through an open directory and follows no symlink, at any level;
- copies only directories, regular files and symlinks, each created fresh by the supervisor: directories 0700, files
  with their permission bits only (no setuid, setgid or sticky bit) and their times, symlinks with their target as
  text; no owner and no xattrs;
- checks that each directory and file it creates sits at its own path under the destination;
- stops at a device, FIFO or socket (`special_file`), past `BOTS_STATE_MB` of file data (`too_large`), past the
  tmpfs's file count (`too_many_files`) or past 64 directory levels (`too_deep`).

A save writes `state.new` and fsyncs it, renames `state` to `state.old` and `state.new` to `state`, fsyncing the
bot's directory after each rename, then removes `state.old` and fsyncs again; a start first finishes or undoes a swap
a crash interrupted, the same way. Each bot takes at most about 2 × `BOTS_STATE_MB` on the volume. A save that fails
or stops keeps the previous copy and logs `snapshot_failed` with its cause (`snapshot_skipped` if the sandbox could
not be paused). A restore that fails or stops fails the start with `state restore failed: <cause>` and leaves the
saved copy as it is.

Teardown gives `runsc run` a few seconds to finish on its own, then ends the sandbox. A stop is confirmed when a
sandbox runsc listed as running was killed, `runsc delete` succeeded, `runsc list` no longer shows it and its cgroup
holds no process. Only then is the state saved and the tmpfs unmounted. Otherwise the supervisor logs
`teardown_unconfirmed` and `snapshot_skipped` (cause `teardown_unconfirmed`), copies nothing and leaves the tmpfs
mounted; the bot's next start tries to confirm the end again and gets `bot_unavailable` until it is confirmed.

The supervisor reads the mount flags back from `/proc/self/mountinfo`: a state tmpfs without nosuid,nodev,noexec
fails the start, and a `bot-data` volume without nosuid,nodev (it is remounted that way at startup) stops the
supervisor from starting.

### Budget file recovery

If `budget.json` is unreadable or malformed, the gateway logs one line and exits with status 78:

```json
{"gateway":"refusing_to_start","reason":"budget file /var/lib/bots-gateway/budget.json is unreadable (…)","fix":"…"}
```

Under `restart: unless-stopped` Docker keeps restarting it, and every attempt logs the same line, so the loop is
visible in the container logs; bots get no model access meanwhile (their requests to the socket fail). To recover,
fix the file on the `bot-budget` volume as the gateway's user (65532), then restart the gateway:

- restore a known copy, or
- write a conservative file that blocks the rest of today:
  `{"day":"<today, YYYY-MM-DD UTC>","total":<BOTS_GLOBAL_DAILY_TOKENS>,"perBot":{}}`, or
- delete it, which starts today's counters from zero. Only do this if a reset is acceptable; the provider-side
  budget on the dedicated key is then the only limit for the rest of the day.

## Configuration

Supervisor (`bots-supervisor`):

| Var | Default | |
| --- | --- | --- |
| `BOTS_SERVICE_SECRET` | required | unique 256-bit secret (at least 43 characters); `openssl rand -hex 32` |
| `BOTS_ADMISSION_CONTROL_KEY` | unset | admission control socket key from the deploy workflow |
| `BOTS_ACCEPT_LEGACY_OWNER_HEADER` | `0` | see [Deploy order](#deploy-order) |
| `BOTS_TEST_ACCOUNTS` | empty (nobody) | comma-separated addresses, or `*` |
| `BOTS_MODEL` | `z-ai/glm-5.2` | the backend's `REDPILL_DEFAULT_MODEL` default |
| `BOTS_IDLE_MS` | `600000` | idle time after `session_settled` before a sandbox stops |
| `BOTS_SANDBOX_MEMORY_MB` / `_CPUS` / `_PIDS` | `1536` / `1` / `256` | per-sandbox cgroup limits |
| `BOTS_SANDBOX_OVERLAY_MB` / `_TMP_MB` | `512` / `256` | root layer and `/tmp` caps (inside the memory limit) |
| `BOTS_STATE_MB` | `256` | state tmpfs size (inside the memory limit, 64 files and directories per MiB) and the cap on its saved copy |
| `BOTS_TOTAL_MEMORY_MB` / `BOTS_TOTAL_PIDS` | `6144` / `2048` | all sandboxes and their restored state together |
| `BOTS_MAX_RUNNING` | `BOTS_TOTAL_MEMORY_MB / (BOTS_SANDBOX_MEMORY_MB + BOTS_STATE_MB)` (3) | sandboxes running at once; at most that quotient |
| `BOTS_MAX_PER_OWNER` | `10` | one owner's bots, `main` included, that this service holds; a new one past it is refused when announced |
| `BOTS_STATE_COPY_TIMEOUT_MS` | `60000` | a state restore or save still running by then is killed and fails |
| `BOTS_TURN_TIMEOUT_MS` | `300000` | a turn with no result by then is ended and its sandbox killed |
| `BOTS_MAX_TURN_BYTES` | `262144` | assistant text per turn |
| `BOTS_RETENTION_DAYS` | `30` | a bot's working state is deleted after this many days without use |
| `PORT` | `8080` | |

Gateway (`bots-gateway`):

| Var | Default | |
| --- | --- | --- |
| `REDPILL_API_KEY` | required | a dedicated RedPill key with its own provider-side budget, not shared with main chat |
| `BOTS_BACKEND_CALL_SECRET` | unset in local model-only runs | key for bot admission calls |
| `BACKEND_ORIGIN` | `https://api.tinycloud.chat` | HTTPS origin for bot admission at `/api/internal/bots/admit` |
| `BOTS_MODELS` | `BOTS_MODEL` | comma-separated model allowlist |
| `BOTS_MAX_TOKENS` | `8192` | |
| `BOTS_BOT_DAILY_TOKENS` / `BOTS_GLOBAL_DAILY_TOKENS` | `2000000` / `20000000` | UTC day |
| `BOTS_OWNER_DAILY_TOKENS` | `BOTS_BOT_DAILY_TOKENS` | all of one owner's bots together, UTC day |
| `BOTS_MAX_BODY_BYTES` / `BOTS_MAX_RESPONSE_BYTES` | 4 MiB / 8 MiB | |
| `BOTS_UPSTREAM_CONNECT_TIMEOUT_MS` / `BOTS_UPSTREAM_TOTAL_TIMEOUT_MS` | `30000` / `600000` | |
| `BOTS_BODY_TIMEOUT_MS` | `30000` | request body deadline |
| `BOTS_BUDGET_FILE` | `/var/lib/bots-gateway/budget.json` | on the `bot-budget` volume |
| `TAVILY_API_KEY` | empty | Main's web access: the search provider's key; empty refuses every web call as unavailable |
| `BOTS_WEB_BOT_DAILY_SEARCHES` / `BOTS_WEB_BOT_DAILY_PAGES` | `100` / `300` | per bot, UTC day |
| `BOTS_WEB_GLOBAL_DAILY_SEARCHES` / `BOTS_WEB_GLOBAL_DAILY_PAGES` | `2000` / `6000` | all bots, UTC day |
| `BOTS_WEB_TIMEOUT_MS` | `20000` | per provider call |
| `BOTS_OWNERS_FILE` | `owners.json` beside the budget file | which owner each bot belongs to |

`BOTS_TEST_UPSTREAM_URL` and `BOTS_TEST_WEB_URL` exist only for local mocks: each must be a loopback `http://` URL, and
the compose file never passes either.

## Pinning

- gVisor release 20261102.0, sha512-checked in the Dockerfile.
- OMP `@oh-my-pi/pi-coding-agent@18.18.6` and every dependency from `sandbox/bun.lock`, installed with
  `bun install --frozen-lockfile`.
- The Bun base image by digest. The bot rootfs has no curl.
- In `docker-compose.phala.yml`, both images by digest, written into the file at deploy time.

## Why the supervisor has these capabilities

`runsc` needs `SYS_ADMIN`, `SYS_CHROOT`, `SETUID`, `SETGID`, `SETFCAP`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `CHOWN`,
`KILL`, with seccomp and AppArmor unconfined, to create a sandbox; this is the smallest set that passed the local
smoke (without `SETFCAP` the gofer fails with `fork/exec /proc/self/exe: operation not permitted`;
`DAC_READ_SEARCH` and `MKNOD` are not needed). Each bot's state is a tmpfs the supervisor mounts itself, so the
container needs no devices. At startup the supervisor remounts its cgroup2 namespace read-write (Docker mounts it
read-only), moves itself into a leaf cgroup so each sandbox can have its own limits, and remounts the `bot-data`
volume nosuid,nodev. If the host lacks any of this (a private cgroup namespace, the cpu, memory and pids
controllers, or one of those mounts), the supervisor exits before serving, and the container log shows the error
naming what is missing, for example
`supervisor needs a private cgroup2 namespace (cgroup: private); /proc/self/cgroup is "…"`,
`cgroup controllers unavailable: memory`, or the `mount` command that failed with its exit code and output. Under
`restart: unless-stopped` each restart logs the same error.

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
SSE events for two owners, the busy rule, history, the running cap, a gateway restart (budgets kept, the bot
registered again), the idle stop and restart, a containment checklist (two sandboxes, aggregate caps, egress and
state isolation, caps, no network, no model key in a sandbox or the supervisor, no devices), and the saved state:
kept across a stop and start, with setuid bits dropped, symlinks kept as symlinks and nothing written outside; a FIFO
the bot makes stays inside gVisor, and a FIFO on the tmpfs stops the save while the previous copy stays. It exits 1
if any check fails. Report its result as a mock run. It removes everything it creates. CI
(`.github/workflows/bots.yml`) runs the unit tests and the typecheck on every PR touching `bots/`; the smoke needs a
Docker host and runs by hand.

## Deploying

`.github/workflows/deploy-bots-phala.yml` deploys a commit on main to the dedicated bots CVM:

```bash
gh workflow run deploy-bots-phala.yml --ref main -f ref=<full main SHA>
```

It builds `bots/` (`linux/amd64`) as `ghcr.io/tinycloudlabs/tinychat-bots:<sha>` and the backend's ingress image
(`infra/phala-ingress`) as `ghcr.io/tinycloudlabs/tinychat-backend:ingress-bots-<sha>`, writes both pushed digests
over `BOTS_IMAGE_DIGEST` and `INGRESS_IMAGE_DIGEST` in a copy of `docker-compose.phala.yml`, and deploys that copy
with the complete encrypted env set below. It checks the CVM runs the backend's pinned dstack OS image before and
after, syncs `allowed_envs`, and probes `/healthz` for `ok` through the CVM's TLS-passthrough host. The job summary lists the
commit, both digests, the rendered compose's sha256 and the env names. To roll back, run it with an earlier SHA;
the `bot-data` and `bot-budget` volumes are kept.

The bots service is live when this check passes. Run it the same way outside the workflow:

```bash
node .github/scripts/bots-healthz.mjs <APP_ID>-443s.<gateway> bots.tinycloud.xyz
```

`<APP_ID>-443s.<gateway>` is the CVM's TLS-passthrough host (the backend's `BOTS_SERVICE_CONNECT_HOST`), and the
certificate is checked against `bots.tinycloud.xyz`. The public name bots.tinycloud.xyz does not route; never probe it.

Its configuration lives in the `production-bots` GitHub environment:

| Name | Kind | |
| --- | --- | --- |
| `BOTS_PHALA_CVM_ID` | variable | the bots CVM; required, never the backend's `PHALA_CVM_ID` |
| `BOTS_INGRESS_DOMAIN` | variable | the bots TLS hostname; required |
| `BOTS_TEST_ACCOUNTS` | variable | the same list as the backend's; empty admits nobody |
| limit overrides from [Configuration](#configuration) | variables | optional, e.g. `BOTS_MODEL`, `BOTS_TOTAL_MEMORY_MB`, `BOTS_GLOBAL_DAILY_TOKENS`; empty keeps the compose default |
| `PHALA_CLOUD_API_KEY` | secret | deploy tooling only; never a CVM env |
| `BOTS_SERVICE_SECRET` | secret | the supervisor's secret, the same value as the backend's |
| `BOTS_BACKEND_CALL_SECRET` | secret | bot admission key |
| `BOTS_ADMISSION_CONTROL_KEY` | derived | control socket key from the deploy workflow |
| `BACKEND_ORIGIN` | variable | set from `TINYCHAT_BACKEND_URL` in the deployment environment, default `https://api.tinycloud.chat` |
| `BOTS_REDPILL_API_KEY` | secret | the dedicated RedPill key, written to the CVM as `REDPILL_API_KEY` |
| `BOTS_TAVILY_API_KEY` | secret | optional; the search provider key for Main's web access, written to the CVM as the gateway's `TAVILY_API_KEY` |
| `CLOUDFLARE_API_TOKEN`, `CERTBOT_EMAIL` | secrets | the ingress certificate |

`PHALA_GATEWAY_CNAME` is read from the CVM. No other secrets belong in this CVM.

The operator points `BOTS_INGRESS_DOMAIN` at the CVM with a DNS CNAME to its Phala gateway (`.gateway.cname`, shown
in the job summary).

The backend picks up `BOTS_ENABLED`, `BOTS_TEST_ACCOUNTS`, `BOTS_SERVICE_URL=https://<BOTS_INGRESS_DOMAIN>` and
`BOTS_POST_TIMEOUT_MS` from `production-api` variables and `BOTS_SERVICE_SECRET` from a `production-api` secret,
through `.github/workflows/deploy-backend-phala.yml`. `BOTS_ENABLED` defaults to `false`.

### Deploy order

Set `BOTS_ACCEPT_LEGACY_OWNER_HEADER=1`, deploy the bots service, then the backend, then set it to `0` and deploy the bots service again. After each step, check that the bots service answers 200. Once it does with `0`, remove the variable.
