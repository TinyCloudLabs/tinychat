# What Main can reach: TinyCloud MCP, the web, owner-added MCP servers

Details: TC-2808 (follow-on to [`tiny-bots-slice1.md`](tiny-bots-slice1.md)). Design only: nothing here is built.

## Goal

Today Main can only talk to its model. It cannot read the owner's data, search the web, read a page or use any tool,
which makes it a chat box. This plan gives it three capabilities, each opt-in per owner, built in this order:

1. the owner's own TinyCloud data, read only, through the hosted MCP (`https://mcp.tinycloud.xyz/mcp`);
2. web search and page fetch, done by the gateway;
3. remote MCP servers the owner adds themselves.

All three follow the same rules: the sandbox never holds a credential and never has a network, the gateway holds
every credential and makes every outside call, the owner sees and controls each one, each has budgets, the audit log
holds counts and never content, and the owner can revoke each at any time.

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

### 1. The gateway is Main's one MCP server

The gateway gains one route on each bot's socket, `POST /v1/mcp`. To the sandbox it is a single MCP server (OMP's MCP
client is pointed at `http://127.0.0.1:8080/v1/mcp`; the config key is confirmed at build). Behind it the gateway
serves the tools of whatever the owner has enabled: the hosted TinyCloud MCP (sections 2 to 4), its own web tools
(Web access, below) and the owner's added servers. Tool names are namespaced (`tinycloud__kv_get`, `web__fetch`,
`<server slug>__<tool>`) so a server cannot shadow another's tool. The sandbox never names a host. The model routes,
the one-request-per-bot slot, the 4 MiB body cap and the response cap apply to this route too.

The gateway reads the JSON-RPC request and rebuilds it, as it does for chat bodies. It passes only `initialize`,
`notifications/initialized`, `ping`, `tools/list` and `tools/call`. Everything else (resources, prompts, sampling,
elicitation, roots) is answered locally with a fixed error and never sent. `tools/call` is passed only for a tool on the
bot's allowlist; `tools/list` answers are rebuilt from that list. The gateway owns every upstream MCP session id and
`Authorization` header; the sandbox sees neither. The only hosts the gateway ever calls for a bot are: the model
origin, `mcp.tinycloud.xyz/mcp` (phase 1), the search provider and guarded page fetches (phase 2), and the owner's
servers (phase 3).

### 2. Who holds the grant

The credential is an OpenKey OAuth access token (and, for a standing grant, its refresh token) for the owner, kept in
the gateway, outside the sandbox, like the model key.

- It gets there once, at approval. The owner approves in OpenKey in their browser and the TinyChat backend receives the
  authorization code. It passes the code and its PKCE verifier to the supervisor over the existing
  service-authenticated call, and the supervisor hands them to the gateway over the gateway's admin socket
  (`PUT /bots/<botId>/mcp-grant`). The gateway does the code exchange, so the token is first seen inside the gateway.
  The backend and supervisor never see, log or store it.
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

## Web access (phase 2)

The gateway offers two tools, `web__search` and `web__fetch`, and makes the calls itself. The sandbox has no raw
network and gets no new route beyond `/v1/mcp`.

**Search provider.** The provider key is a gateway credential, like the model key. Candidates, none chosen:
Tavily (the backend already uses it for chat web search, `backend/src/mcp-meetings/web-search.ts`, and it also has a
page-extract API), Brave Search API, Exa, Kagi, or a self-hosted SearXNG (no key, but another container to run and
upstream engines that can block it). All except SearXNG are paid keys. **No key is added until it is decided**, and the
bots service gets its own dedicated key with its own provider-side budget, not the backend's. Search queries leave the
TinyCloud trust boundary to the provider, and the owner copy must say so.

**Fetch guards.** Every fetch, and every redirect hop, goes through one guard:
- Scheme `https` or `http` only; no user info in the URL; ports 80 and 443 only; no non-HTTP schemes of any kind.
- The host is resolved by the gateway and **every** address returned is checked; the connection is then made to the
  address that was checked (not resolved again), with the original host in SNI and `Host`. That closes DNS rebinding.
- Refused addresses: loopback, unspecified, private (RFC 1918), shared/CGNAT, link-local (including the cloud metadata
  address `169.254.169.254`), multicast, broadcast, reserved, IPv6 loopback/ULA/link-local, and IPv4-mapped or
  NAT64 forms of any of these. IP literals in decimal, octal or hex form are normalised before the check. Names that
  resolve into the gateway's own compose network are refused by the same rule.
- At most 3 redirects, each re-checked from the start (scheme, host, address); a redirect to a refused target ends the
  fetch.
- GET only; no cookies, no request body, a fixed `User-Agent`, and no header taken from the sandbox.
- Time: 5 s to connect, 15 s total. Size: 1 MiB of body after decompression, read as a stream and cut at the cap.
- Content types: `text/html`, `text/plain`, `text/markdown`, `application/json`, `application/xml`, `text/xml`,
  `application/xhtml+xml`. Anything else is refused, as is a body that does not match its type (for example a
  `%PDF` or image magic number behind `text/html`).
- The gateway turns HTML into plain text (scripts, styles and hidden elements dropped) and returns at most 40,000
  characters, wrapped as untrusted content (below).

**Budgets** (starting values): per task, 10 searches and 20 fetches; per bot per day, 100 searches and 300 fetches;
a global daily cap; one web call in flight per bot. Returned text also counts against the token budgets.

**Audit and owner view.** Counts by tool and outcome (`ok`, `blocked_address`, `blocked_scheme`, `too_large`,
`wrong_type`, `timeout`, `budget`), bytes returned. No query, no URL, no page text. The settings row shows "Main
searched 4 times and read 9 pages today." Blocked attempts are counted separately so a spike is visible.

**Owner control.** Web access is off by default and is a per-owner switch with two choices, "Just for this task" and
"Until I turn it off". It carries no owner credential and no owner data, so it has no expiry; the 1-hour and 7-day rules
are for owner authority. Turning it off ends it at the next call.

**Untrusted text.** Everything that comes back from the web (and from an owner-added server, below) is data, not
instructions, and the design does not rely on the model to tell the difference:
- The gateway wraps it as quoted content with a fixed label and gives it no authority; a page cannot add a tool, widen a
  grant, change an allowlist or raise a budget, because those live in the gateway and the owner's settings, not in the
  conversation.
- Grant-bearing tools (TinyCloud data, an owner's server) are still gated by their allowlist, scope, budget and
  expiry. Writes are not exposed in phase 1; a later write phase confirms each write with the owner outside the model.
- The remaining risk is leaking data the bot legitimately read, through a URL or a search query. So once a task has read
  owner data (any grant-bearing call), `web__fetch` in that task accepts only a URL the owner typed or one a search in
  the same task returned, and a query longer than 200 characters is refused. This narrows the channel, it does not
  close it: a URL path or a query string can still carry a few words. Whether to go further and turn web
  access off for the rest of any task that has read owner data is decision 5 below.

## Owner-added MCP servers (phase 3)

The owner can add a remote MCP server (streamable HTTP) so Main can use its tools. Everything about a server is held
and enforced by the gateway.

**Adding one.** Settings, "Tools Main can use", "Add a tool server". The owner enters an `https` URL (no `http`, no
user info, port 443 only). The gateway, not the backend or the browser, contacts it, through the same guard as page
fetches (resolve, check every address, connect to the checked address, no redirects on MCP calls, 10 s total). It runs
`initialize` and `tools/list` and returns what the owner needs to decide: the host, the server's own name, and its
tools by name and description.

**What the owner approves, per server:**
1. the server (its host is shown exactly as it will be contacted);
2. which of its tools Main may use. None is selected by default. The server's read-only hints are shown as hints and
   never trusted;
3. how long: "Just for this task" (up to 1 hour) or "For 7 days", with the same warning screen before 7 days as for
   TinyCloud data, and no silent renewal.

**Credential.** If the server supports the MCP authorization flow (OAuth with PKCE), the owner signs in at the server in
their browser and the gateway does the code exchange, as in section 2. If it takes a bearer key instead, the owner pastes
it once into a field that posts it to the supervisor and on to the gateway; the browser, backend and supervisor do not
keep it. The gateway holds it as in section 2 (memory for one task; encrypted on its volume for 7 days). The token endpoint
and every URL the gateway fetches for the flow go through the same guard.

**Per-server tool allowlist and pinning.** Tools are exposed as `<slug>__<tool>`. The gateway hashes each approved
tool's name, description and input schema at approval. If the server later changes one, that tool is withheld until the
owner approves the change. Descriptions are truncated to 500 characters, schemas must be plain JSON Schema within a size
cap, and both are treated as untrusted text. A server can't add a tool to the allowlist by announcing it.

**Budgets** (starting values): at most 5 servers per owner; per server per task 20 calls and 256 KiB of results; per
server per day 300 calls; one call in flight per server; 20 s per call.

**Audit and owner view.** Counts per server, tool and outcome (`ok`, `tool_not_permitted`, `grant_ended`,
`server_changed`, `blocked_address`, `server_unavailable`, `budget`). No arguments, results, tokens or URLs. Settings
list each server with its tools, expiry and "Used 6 times today", and a "Remove" button.

**Remove and revoke.** Remove deletes the credential in the gateway, closes the upstream session (`DELETE` with the
session id), calls the server's revocation endpoint if it advertises one, and the next call is refused. A server that
does not honour revocation keeps a token that only the gateway held, until it expires.

**Failures.** The same fixed one-line errors as section 4: server unreachable or slow (no retry; 3 in a row pause the
server for 60 s), token expired (owner sees "<server> access has ended" with "Add it again"), refused address,
tool changed, over budget.

### Owner copy for review (Monica)

| Where | Draft |
| --- | --- |
| Web, off | "Web" / "Main can't search the web or read pages." / "Let Main use the web" |
| Web, choice | "Let Main use the web?" / "Main can search and read public pages. Searches go to a search provider." / "Just for this task" / "Until I turn it off" |
| Web, on | "Main can use the web." / "Searched 4 times and read 9 pages today." / "Turn off" |
| Add server | "Add a tool server" / "Paste the address of an MCP server you trust." / "Main can use the tools you allow, nothing else." |
| Server tools | "<name> (<host>)" / "Choose what Main may use" (none ticked) |
| Server, 7 days | "Keep <name> connected for 7 days?" / "Main keeps using the tools you picked until you remove it or 7 days pass." / "Keep it to this task" / "Allow 7 days" |
| Server, active | "<name> can be used until <time>." / "Used 6 times today." / "Remove" |
| Server, ended | "<name> access has ended." / "Add it again" |

## Build order

1. **TinyCloud MCP.** Builds the shared parts the others reuse: the `/v1/mcp` route and JSON-RPC rebuild, the grant
   store and admin-socket hand-off, the budget ledger, the count-only audit, the settings surface and the owner events.
2. **Web.** Adds the guarded fetcher (the SSRF guard is its own module with its own tests, and is the piece phase 3
   reuses), the provider adapter and the web tools. Waits on the provider decision.
3. **Owner-added servers.** Adds the server registry, discovery, the credential flows, tool pinning and the settings
   list. The guard from phase 2 is a prerequisite, so this cannot be built before it.

Each phase ships behind the existing test-account flag and does not change the others.

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
4. **Search provider and its key** (a paid credential, so not added without an explicit decision): which of Tavily,
   Brave, Exa, Kagi or self-hosted SearXNG, and a dedicated key for the bots service.
5. **After owner data is read in a task, should web access stop entirely** (strict), or only narrow to owner-typed and
   search-returned URLs with a query length cap (this plan's default)?
6. **Web access has no expiry** (it carries no owner authority). Say so if it should expire like the data grants.

## Smoke check for a later build

On a flagged test account:
- **TinyCloud:** approve "Just for this task" on one app, ask Main to list that app's keys (they come back); ask it to
  read another app (refused by the node); after the turn, a second call is `grant_ended`; Disconnect during a 7-day grant
  and the next call fails; a write tool is `tool_not_permitted`.
- **Web:** a fetch of a public page returns text; `http://127.0.0.1`, `http://169.254.169.254`, a name that resolves to a
  private address, and a redirect to either are each refused and counted as `blocked_address`; a 2 MiB page is cut; a
  PDF is `wrong_type`; the 21st fetch in a task is `budget`.
- **Owner-added server** (a local test server): the tool list shows; an unselected tool is refused; changing a tool's
  description withholds it; Remove ends the next call.
- **Everywhere:** the sandbox's environment, filesystem and a captured request contain no token or key. Report a mock run
  as a mock.
