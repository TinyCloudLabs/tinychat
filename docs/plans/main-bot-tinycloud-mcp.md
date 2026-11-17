# Main bot and the TinyCloud MCP

Details: TC-2808 (follow-on to [`tiny-bots-slice1.md`](tiny-bots-slice1.md)). Design only: nothing here is built.

## Goal

Let an owner choose to give their Main bot read access to their own TinyCloud data through the hosted MCP
(`https://mcp.tinycloud.xyz/mcp`), without the sandbox ever holding a credential or reaching any host but its gateway.

## Today

- The sandbox runs under gVisor with `--network=none`. Its only way out is its own Unix socket, bridged to
  `127.0.0.1:8080` inside the sandbox (`bots/sandbox/bot-start.sh`).
- `bots-gateway` accepts only `POST /v1/chat/completions` and `GET /v1/models` on that socket, with the bot's own token,
  and forwards to the fixed origin `https://tee.redpill.ai` with the model key it alone holds (`bots/README.md`).
  A bot is registered with the gateway over its admin socket (`PUT /bots/<botId>`); registrations do not survive a
  gateway restart.
- OMP in the sandbox has no MCP server configured.
- Hosted MCP facts this design relies on (js-sdk `packages/mcp` and OpenKey `docs/resource-server-token-status.md`):
  - An OAuth access token for `https://mcp.tinycloud.xyz/mcp` lasts 12 hours (OpenKey #417, TC-1366); refresh tokens
    last 7 days; a connection ends at the 30-day sign-in cap. The scope is `tinycloud:mcp`.
  - The MCP checks every token with OpenKey's token-status endpoint and reuses an active answer for 30 s. If OpenKey
    cannot answer, it serves a token only if OpenKey called it active within the last 60 s. A revoked token, a withdrawn
    consent or an ended sign-in is `active: false`.
  - The token identifies the owner. Authority over data is separate: each operation needs a TinyCloud delegation the
    owner approved through OpenKey. When it is missing the tool answers `authority_required` with a short-lived approval
    link. Production requests 30-day delegations and 15-minute links (`TC_MCP_DELEGATION_EXPIRY=30d`).
  - A delegation cannot be revoked early: the MCP has no revoke route for them (TC-1156). Tokens can be revoked;
    delegations end at their expiry.
  - The owner sees and disconnects connected MCP apps on the OpenKey account page, and sees the MCP's delegation on
    `account.tinycloud.xyz/delegations`.
  - The MCP logs only the tool name, a result code, the duration and a replay count.
  - The TinyChat backend already reaches the MCP for meeting transcripts with an owner-signed, read-only grant to a
    service identity (`MCP_CHAT_*`, `backend/src/mcp-meetings`). That path accepts exactly one grant shape (the
    connectors database and prefix, read only, at most 30 days), so it cannot carry this design as it is.

## Design

### 1. One more destination, one more route

The gateway gains one route on each bot's socket, `POST /v1/mcp`, that forwards to exactly one origin and path,
`https://mcp.tinycloud.xyz/mcp`. Nothing else changes: the model routes, the one-request-per-bot slot, the 4 MiB body
cap, refused redirects and the 8 MiB response cap apply to it too. The sandbox never names a host; OMP's MCP client is
pointed at `http://127.0.0.1:8080/v1/mcp` (the config key is confirmed at build).

The gateway reads the JSON-RPC request and rebuilds it, as it does for chat bodies. It passes only `initialize`,
`notifications/initialized`, `ping`, `tools/list` and `tools/call`. Everything else (resources, prompts, sampling,
elicitation, roots) is answered locally with a fixed error and never sent. `tools/call` is passed only for a tool on the
bot's allowlist (section 3); `tools/list` answers are filtered to that list. The gateway owns the MCP session id and
the `Authorization` header; the sandbox sees neither.

### 2. Who holds the grant

The credential is an OpenKey OAuth access token (and, for a standing grant, its refresh token) for the owner, kept in
the gateway, outside the sandbox, like the model key.

- It gets there once, at approval. The owner approves in OpenKey in their browser. The TinyChat backend completes the
  code exchange and hands the token to the supervisor over the existing service-authenticated call, and the supervisor
  hands it to the gateway over the gateway's admin socket (`PUT /bots/<botId>/mcp-grant`). The backend and supervisor
  keep it in memory for that one hand-off, never log it and never store it.
- A one-off grant lives only in the gateway's memory. A gateway restart ends it, which is the same as it expiring.
- A standing grant (7 days, renewing) must survive a restart, so the gateway writes its refresh token to its own volume,
  encrypted (AES-GCM, key from the gateway's environment like the model key), mode 0600.
- The sandbox, the supervisor and the saved bot state never hold it. The gateway removes the `Authorization` header and
  any token from everything it returns, and it strips the approval link from an `authority_required` result (the link
  goes to the owner through the supervisor's event stream, section 3, never to the model).
- Lifetime follows the owner's grant rules:
  - **One-off**: 1 hour at most, for one task, no renewal. The grant ends when Main's turn settles or after 1 hour,
    whichever is first.
  - **Standing**: 7 days, renewing, only if the owner picks it, and only after a warning screen. No default, no nudge.
  - Anything involving another app's data or cross-app access gets the extra warning on the approval screen, with
    "Reject this permission".
- The access token is valid at the MCP for up to 12 hours whatever the grant says. So the gateway enforces the grant's
  end itself (it stops attaching the token) and also revokes the token at OpenKey when a grant ends (section 3).

### 3. Limits, budgets, audit, revoke, what the owner sees

**Tools.** Phase 1 is read-only. The allowlist is the hosted tools whose only effect is `read`, minus the ones that mint
authority or return secrets:

- exposed: `tinycloud_kv_get`, `tinycloud_kv_head`, `tinycloud_kv_list`, `tinycloud_sql_query`,
  `tinycloud_sql_schema_inspect`, `tinycloud_read`, `tinycloud_knowledge_list`, `tinycloud_knowledge_read`,
  `tinycloud_apps_read`, `tinycloud_account_spaces_list`, `tinycloud_status`;
- not exposed, ever: `tinycloud_auth_request`, `tinycloud_auth_read_scope`, `tinycloud_connect`, `tinycloud_secrets_get`
  (secrets stay on their own short-lived policy);
- not exposed in phase 1 (writes, or reads with a side effect): `tinycloud_kv_put`, `tinycloud_kv_delete`,
  `tinycloud_sql_execute`, `tinycloud_apps_write`, `tinycloud_apps_query`, `tinycloud_apps_context`,
  `tinycloud_account_applications_list`. A write phase needs its own plan and its own approval copy.

The delegation is the real limit: the owner picks the space and prefixes or databases when approving, and the node
refuses anything outside them. The gateway's list is a second layer, not the first.

**Budgets** (starting values, tuned after the first run): per task, 30 tool calls and 256 KiB of results; per bot per
day, 500 calls; one call in flight per bot; 20 s per call; results already capped by the MCP at 100,000 characters.
Results enter the model's context, so they also count against the existing per-bot and global token budgets.

**Audit.** The gateway logs counts, never content: per bot (hashed id) and day, calls by tool name and outcome
(`ok`, `tool_not_permitted`, `grant_ended`, `authority_required`, `mcp_unavailable`, `budget`), bytes returned. No
arguments, no results, no token, no approval link. The owner sees the same counts in Main's settings.

**Revoke.** Disconnect in Main's settings tells the backend, which tells the supervisor, which has the gateway delete
the grant and call OpenKey's revoke for the access and refresh tokens. The gateway checks the grant on every call, so
the next call is refused. At the MCP the token is inactive within about 30 s. The owner can also remove the connection
on the OpenKey account page, which ends the token the same way. The delegation underneath cannot be revoked early; it
stays bounded by the 1-hour or 7-day window, and only the gateway ever held it.

**What the owner sees** (copy for review; every string lives in the bots strings module):

| Where | Draft |
| --- | --- |
| Main's settings, off | "TinyCloud data" / "Main can't read your TinyCloud data." / button "Let Main read it" |
| Choice sheet | "Let Main read your TinyCloud data?" / "Main can read what you pick, nothing else. It can't change anything." / options "Just for this task (up to 1 hour)" (selected), "For 7 days" / "You pick what Main can read" (app list, none selected) |
| After "For 7 days" | warning screen: "Keep Main's access for 7 days?" / "Main will keep reading what you picked, and the access renews on its own, until you turn it off or 7 days pass." / "Keep it to this task" / "Allow 7 days" |
| Approval | OpenKey's own screen, including its extra warning and "Reject this permission" when another app's data is involved |
| Active | "Main can read <apps> until <time>." / "Used 12 times today." / button "Disconnect" |
| Ended | "Main's access to your TinyCloud data has ended." / "Give Main access again" |

Copy goes to Monica before any of it ships. It makes no claim about encryption or about what Main may do later.

### 4. Failure modes

Each answers the model with a fixed one-line error (no upstream text) and logs a count.

| Case | What happens |
| --- | --- |
| Grant expired, revoked or gateway restarted | `grant_ended`. The model is told access ended. The supervisor sends the owner a `grant_needed` event; the "Ended" line shows. No retry loop. |
| MCP down, 5xx, timeout, or the MCP's `server_error` because OpenKey is unreachable | `mcp_unavailable`. No retry of the call. After 3 in a row the gateway refuses for 60 s. The turn goes on without the data. |
| Tool not on the allowlist | Refused locally, `tool_not_permitted`; never sent. |
| `authority_required` (Main asked for more than the owner approved) | The approval link is stripped from the result; the owner gets "Main needs more access: <what>" with a Review button that opens OpenKey. Nothing is widened automatically. |
| `invalid_token` / 401 | Treated as the grant ending, as the first row. |
| Over a per-task or per-day budget, or a second call in flight | Refused, `budget`, with the body unread. |
| Oversize or malformed response | Dropped; `mcp_unavailable`. |

## Decisions for the owner of each system (named, not designed here)

1. **OpenKey** (its owner decides): how a bot requester appears on the approval screen: the 1-hour one-off as the
   default and the 7-day renewing choice behind a warning; a "Reject this permission" control (the approval screen on
   main today has a request-level decline and a "belongs to another user" note, and no per-permission reject); the OAuth
   client and the name shown ("Main, TinyCloud One").
2. **Hosted MCP** (js-sdk `packages/mcp`): production delegations are 30 days, and the native grant path accepts one
   fixed shape. The grant rules need a per-request expiry of 1 hour or 7 days and an owner-chosen read scope, either by
   the MCP honouring the requested expiry or by a new restricted address for Main. A new address is a new OpenKey
   audience and callback as well, so it joins decision 1.
3. **What "one task" means.** This plan ends the grant when Main's turn settles. If a follow-up message should reuse it,
   say so before build.

## Smoke check for a later build

On a flagged test account: approve "Just for this task" on one app, ask Main to list that app's keys (they come back);
ask it to read another app (refused by the node); after the turn, a second call is `grant_ended`; Disconnect during a 7-day
grant and the next call fails; a write tool is `tool_not_permitted`; the sandbox's environment, filesystem and a captured
request contain no token. Report a mock-MCP run as a mock.
