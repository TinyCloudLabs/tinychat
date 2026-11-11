# Tiny bots, slice 1: Main in its own gVisor sandbox, chat from Home

Details: TC-2808

## Scenario
A test account opens TinyCloud Home, types in the "What do you want done?" box, and sees Main, its main bot, reply in Main's chat, streamed. Main is an OMP instance in its own gVisor sandbox inside a TDX CVM, answering on TinyCloud's model service (RedPill). Accounts not on the test list see today's Home unchanged.

## Pieces and contracts

### 1. bots service (`bots/`, its own CVM)
- Two containers. The supervisor (Bun HTTP server) holds `runsc` (gVisor release 20261102.0, sha512-checked) with a reduced capability set instead of `privileged`; it is still effectively root of the CVM, so gVisor is the only boundary between a bot and the CVM. It runs one sandbox per owner's Main bot. The gateway is its own unprivileged, read-only container with no capabilities, and is the only holder of the model key. They share per-bot egress sockets on a tmpfs volume.
- Sandbox: `runsc --platform=systrap --network=none --host-uds=open`, its own private rootfs layer (shared read-only lower, per-sandbox size-capped memory overlay), a capped `/tmp`, its own cgroup (memory, CPU, pids), a fixed-size state image at `/data/bots/sha256(ownerDid)`, and a read-only `/run/egress` holding only that bot's socket, bridged to `127.0.0.1:8080` inside the sandbox. OMP 18.18.6 (lockfile-pinned) runs as `omp --mode rpc --no-ui` and its stdio is the supervisor's RPC channel; UI and host-action requests are refused, lines are length-capped, and every SSE event is re-encoded from parsed fields.
- Gateway: allows only `POST /v1/chat/completions` and `GET /v1/models` (filtered to the model allowlist), only with that bot's own token (constant-time); rebuilds the body from an allowlist; sets `provider: { aci_verified: true, allow_fallbacks: false }` and usage reporting; caps `max_tokens`, body and response size, timeouts; per-bot and global daily token budgets; one upstream call per bot; upstream host fixed to `https://tee.redpill.ai`; redirects refused. Uses a dedicated model key with a provider-side budget. Receipts are not verified in this slice, so no screen says private, confidential or verified.
- Lifecycle: create Main's sandbox on the owner's first message; stop it after it is idle (OMP `session_settled` plus an idle timeout); start it again on the next message with the same state. Listing a stopped bot's messages starts it.
- The bots side also enforces `BOTS_TEST_ACCOUNTS` and the owner format `^did:pkh:eip155:1:0x[0-9a-f]{40}$`. TLS ends inside the CVM (dstack-ingress); the supervisor has no published plain port.
- Internal API (service-authenticated; never exposed to browsers):
  - Every request: `Authorization: Bearer <BOTS_SERVICE_SECRET>` (constant-time compare) and `X-TinyCloud-Owner: <owner did:pkh, lowercased address>`. Missing or wrong: 401, nothing else said.
  - `POST /v1/bots/main/messages` body `{ "text": string }` (1..8000 chars) → `text/event-stream`:
    - `event: status` `{ "state": "starting" | "working" }`
    - `event: delta` `{ "text": string }` (assistant text deltas)
    - `event: done` `{ "messageId": string }`
    - `event: error` `{ "code": "bot_unavailable" | "model_unavailable" | "busy" | "invalid", "message": string }` (plain sentence, no provider text)
  - `GET /v1/bots/main/messages` → `{ "messages": [{ "id": string, "role": "user" | "bot", "text": string, "at": string }] }` (newest last, at most 50).
  - `GET /healthz` → 200 `ok` (no auth).
- One message at a time per bot: a second send while one runs gets `busy`.

### 2. tinychat backend
- Flags: `BOTS_ENABLED` (`true` to turn on) and `BOTS_TEST_ACCOUNTS` (comma-separated addresses, `*` for everyone), same pattern as `MCP_CHAT_ENABLED` / `MCP_CHAT_TEST_ACCOUNTS`. Config: `BOTS_SERVICE_URL`, `BOTS_SERVICE_SECRET`.
- Routes (existing session auth; owner from `req.user.address`, never from the body):
  - `GET /api/bots/status` → `{ "enabled": boolean }`.
  - `POST /api/bots/main/messages` → proxies the SSE stream above unchanged; 404 when the account isn't enabled.
  - `GET /api/bots/main/messages` → proxies the list; 404 when not enabled.
- No chat content is logged or stored by the backend.

### 3. Home frontend
- On the Home surface (the feed), for accounts where `GET /api/bots/status` says enabled: the "What do you want done?" box at the top (layout C from the mockups, branch `feat/tiny-bots-mockups`, `frontend/src/harness/screens/botsC.tsx`), with Main's icon avatar.
- Sending opens Main's chat over Home: the user's message, then Main's reply streaming in, a composer "Message Main", and a close/back control. It loads earlier messages from `GET /api/bots/main/messages`.
- Avatars: the icon style from the mockups (`frontend/src/harness/mock/BotAvatar.tsx`): Main uses a sparkles icon on a soft tint.
- Accounts not enabled: nothing changes.
- Strings: every new owner-visible string goes in one module and goes to Monica.

## Smoke check
A flagged test account on a deployed preview: type "Reply with exactly: pong" in the Home box; Main's chat shows a streamed reply containing "pong". Local equivalent: bots service in Docker with gVisor + the backend + the frontend dev server, against the real model with a test key, or a mock upstream when no key is present (mock runs are reported as mock, never as the happy path).

## Not in this slice
Feed posting, making new bots, the Bots grid with real data, routines, replacing today's chat, mirroring chat history to the owner's TinyCloud, receipt verification in the bots gateway, other model providers, connected chat apps.
