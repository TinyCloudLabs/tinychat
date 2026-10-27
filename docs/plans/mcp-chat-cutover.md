# TC-2196 plan: TinyChat private chat on the TinyCloud MCP, retire Eliza

Status: plan only, nothing built. Evidence tags: `[master]` = js-sdk origin/master 3b488dd23 (2026-10-27, `@tinycloud/mcp@0.8.3-beta.15`); the local js-sdk checkout is 1972 commits stale (0.3.3-beta.4) so do not read it. `[eliza]` = tinycloud-agents origin/main ed320bd (TC-2163 #31); the local checkout is 27 commits behind. `[TC]` = TinyChat worktree. `DOCS` = tinycloud-dev/docs. `[INFERENCE]` = unverified.

## 0. Summary

**Recommended path (revised after the MCP-side brief, `~/scratch/exo-mcp/mcp-side-brief.md`).** Backend keeps the model loop and Exo's existing four-tool contract (`find/read/search/list_actions`, `backend/src/transcripts/tool-contract.ts`); each tool is executed by a thin Exo-side wrapper over the hosted MCP's existing `tinycloud_sql_query` / `tinycloud_kv_get` (v1 minimum slice: no new MCP tool beyond the single-approval connect). A server-side meeting pack inside the MCP is v2 only if wrapping proves too chatty or unsafe (this supersedes the "pack in the MCP" wording in §1 and §3). Move Eliza's executor quality layer (§6) into the backend. Dual-run behind a flag, gate on a measurable eval, then switch Eliza off.

**Correction to §1/§2/§3 after verification.** Production meeting data lives in db `xyz.tinycloud.tinychat/connectors` (`connector_meeting`, `voice_note_transcript`) + KV `connectors/`: that is what Eliza reads (`transcript-registry.ts:370,405,464,491` @ ed320bd) and what `agentDelegation.ts` grants. The 3-DB format (`details/summaries/transcripts`, `docs/meeting-storage.md`) has **no writer**: `MEETING_DB_*`/`DETAILS_SCHEMA` appear outside tests and `meeting-db/` only in `packages/core/src/index.ts` [grep, worktree]. So the first approval bundle is 1 SQL db + 1 KV prefix, not 3 DBs, until the 3-DB migration ships; the brief's "3 meeting DBs = 3 approvals" is the future shape. Also the backend AES-GCM content store (`services/content-store.ts`) is dark behind `CONNECTOR_BACKEND_INGEST_ENABLED`, default false (`docs/deployment.md:284`), so open question (d) affects only cohort addresses.

**Biggest risk.** The MCP has **no meeting/transcript tools, no app-hints mechanism, and no token path for TinyChat** today, and its approval is NOT one approval: CLI `onboard` is two approvals (one per space) and grants no SQL and no decrypt [master onboard.ts:18-45]. "One approval covers connect+read+write" is a new MCP/OpenKey capability, not an existing one. This is the critical-path dependency on the Artifacts lead and OpenKey.

**Second risk.** Sam's premise "the MCP holds decrypt" does not match TinyChat data today: transcripts are read as plain SQL/KV with no decrypt grant (agentDelegation.ts:57-60; no decrypt step in Eliza). Decrypt in the MCP is whole-network, per-request, and only inside `tinycloud_secrets_get`. Needed only if/when TinyChat data is encrypted [INFERENCE].

**First three steps.**
1. Artifacts lead: spec + build the single-approval connect (applications SQL read on `xyz.tinycloud.tinychat/connectors`, KV get/list on that prefix, plus the voice-note/threads write set; decrypt only if encrypted data ships) and the OAuth token path for TinyChat. Sam/Amos/Naomi decision needed on OpenKey client + deploy (see §5).
2. Exo lead: freeze the answer contract as an eval (reuse `backend/scripts/meeting-eval.ts` + Eliza `tasks/answer.test.ts`), and write the app-hints file from §2.
3. Artifacts lead: meeting tool pack in `packages/mcp` with TC-2163 byte-bounded paging ported; Exo lead: MCP client adapter behind `MCP_CHAT_ENABLED` with test accounts.

## 1. What chat needs from the MCP vs what is missing

### Today's chat path [TC]
- Browser: `chatModelAdapter.ts:484` routes to `streamAgentChat` (`POST /api/agent/chat`) if agent enabled, else plain `/api/chat` plus a browser-side meeting retriever (`chatModelAdapter.ts:305`, `lib/meetingChat/*`).
- Backend `createAgentChatHandler` (`routes/agent-chat.ts:1247`): auth, model allowlist, paywall/credits, `entityId`, Eliza `GET /sessions/:id` liveness (3 s), then Path A (Eliza `POST /tasks` SSE, `agent-task-client.ts`, gated `ELIZA_TASKS_ENABLED`) or Path B (backend loop calling Eliza `POST /tools/:name`, `agent-chat.ts:430-456`). Provider RedPill (`index.ts:1045`).
- Sessions/history: threads are browser-written to the user's own SQL db `xyz.tinycloud.tinychat/threads` (`threadStore.ts:47-88`); the client sends the whole conversation each turn (`chatModelAdapter.ts:428-457`). Backend keeps only in-memory `turns` (`routes/agent.ts:83-90`). So "sessions" are already user-owned; the MCP needs no session store for threads.
- A direction spec already exists: `DOCS/specs/interviews/private-agent.md` (TC-986) already says drop Eliza, backend runs chat, keep web search + 4 meeting tools, no memory grant, no separate agent DID (:80-87), open Q1 = how the backend gets meeting read access (:171). **This plan resolves Q1 as "via the MCP"; the spec needs a matching update.**

### Needs vs MCP today
| Need | MCP today [master] | Gap |
|---|---|---|
| Meeting find/read/search/list-actions | None. Only generic `tinycloud_kv_*`, `tinycloud_sql_query/schema_inspect` (tools.ts:12-36) and `apps_*` (agent-data only). Public `/chatgpt/mcp` has 5 tools. | Build meeting tool pack, or have the model compose SQL+KV (poor: needs the Eliza evidence/size controls). Recommend pack. |
| SQL read on `xyz.tinycloud.tinychat/connectors` | `tinycloud_sql_query` exists (SELECT only, `maxRows/maxBytes`) | Grant: not in onboard (onboard = KV only). |
| Decrypt | Only inside `tinycloud_secrets_get` (`operations/secrets-get.ts:68,104-119`); whole network `:default` (`decrypt-boundary.md`); requested per call, not up front | No generic decrypt-on-read; not needed for today's plaintext meeting data [INFERENCE: plaintext; Eliza README says "plaintext-at-rest today"]. |
| Single approval | `tinycloud_connect` bootstrap = KV get/list on `account` for `spaces/`,`applications/` only (remote-store.ts:32-45); further needs arrive as per-request `authority_required` + `approval.url` (OpenKey), pending TTL 900 s, 64 pending cap. CLI onboard = 2 approvals (applications KV rw, account KV ro), 30d. | Combined one-shot grant; TinyChat needs SQL which onboard lacks. |
| Auth for TinyChat | Bearer JWT, scope `tinycloud:mcp`, aud `https://mcp.tinycloud.xyz/mcp`, `owner_dids` claim + introspection (oauth.ts:13,102; token-status.ts:41). Issuer `api.openkey.so/api/auth` (live metadata). TinyChat has no such token (`tc-1105:184`). | OpenKey OAuth client for TinyChat; backend must hold/refresh per-user token. |
| Per-user isolation | Tenant = HMAC(`TC_MCP_STATE_SECRET`, "tenant:"+sub); per-tenant dir (remote-store.ts:906-908,174-176); new McpServer per request (http.ts:104-124). Good. | Single replica, filesystem store (README). No encryption at rest in app code; delegations/`key.json` plaintext 0600 [remote-store.ts:1038-1048]; disk encryption unverified. |
| Streaming | Server emits no progress; results single JSON (`responseMode:'auto'`) [INFERENCE untested]. | Fine if the backend streams model tokens itself. |
| Model loop owner | MCP has none (tools only). | Backend owns it (decision below). |
| Write path (voice notes, memory) | `kv_put/delete`, `sql_execute` (needs `acknowledgeDatabaseWideAuthority`) | Today the browser writes threads; backend uses a silent writer grant (`transcriptDelegation.ts:182`, `user-space-port.ts`). Decide whether chat writes at all via MCP; recommend no for v1. |
| Response cap | 100,000 chars -> `KV_RESPONSE_TOO_LARGE`/`SQL_RESULT_LIMIT_EXCEEDED` (results.ts:39-45); kv 1 MiB | Eliza has 1 MiB node cap (TC-2163) + 16,000-char tool result cap. Must be re-created in the pack. |
| Private content in logs | Server logs only tool/code/duration/replayed count (logging.ts:1-14; README). But hosted text returns full JSON to client (results.ts:66-70). | Backend and RedPill see it; backend must not log tool results. |

### Today's agent grant vs the one MCP delegation
- Today: two 29-day grants to one shared `AGENT_DID` (agentDelegation.ts:27-42): memory (SQL read/write/admin/schema on `xyz.tinycloud.eliza/memory`, never used by chat) and transcripts (SQL read `xyz.tinycloud.tinychat/connectors`; KV get/list `.../connectors/`, space `applications`; `agentDelegation.ts:57-60`). No decrypt. Backend cannot use it (WRONG_DELEGATEE, routes/agent.ts:150-248).
- MCP-side single delegation must cover at minimum: `applications` space SQL read on `xyz.tinycloud.tinychat/connectors` + KV get/list `xyz.tinycloud.tinychat/connectors/`, plus `account` space KV get/list on `spaces/`,`applications/` (what bootstrap needs). Write scope and decrypt are optional additions. **It is strictly smaller than today's grant if the memory grant is dropped (it should be).** 30d max (OpenKey) matches today.
- Revocation: node-side revoke is honoured and the MCP clears + re-prompts (remote-store.ts ~209-260,450-520); no MCP revoke route (README TC-1156); OAuth revocation does not revoke the delegation.

## 2. App hints

**What exists.** `tinycloud_apps_context` (vendored `tc-apps` skill text, agent-data only) and `tinycloud_knowledge_list/read` which serve `<app>/knowledge/` bundles from the user's `applications` space; MCP `instructions` string is static (http.ts:108-112). No MCP resources/prompts [master grep]. **Proposal: reuse `knowledge_*`.** It is the only existing per-app mechanism and keeps the MCP general.

**Proposal.**
- Owner: each app. TinyChat ships `xyz.tinycloud.tinychat/knowledge/` (e.g. `hints.md`, plus optional `schema.sql` of the exact tables), written to the user's `applications` space at sign-in by the existing app write grant [INFERENCE: depends on knowledge bundle write path; verify with Artifacts lead].
- Size budget: 4 KiB per app hints file (one tool result well under the 100,000-char cap; the model prompt cost is paid per turn).
- MCP combination: `tinycloud_knowledge_list` enumerates installed apps; the MCP `instructions` text (a single line) tells the model to read the hints of the app named by the host (TinyChat's backend can also pre-read and inject it into the system prompt, avoiding a tool round trip; recommended for chat).
- Alternative considered: serve hints from the MCP image (central, but ties app release to MCP deploys, which are manual/Phala). Rejected.

**Draft TinyChat hint content** (real names from [TC] connector-meeting.ts, voiceNoteRows.ts, corpus.ts; Eliza transcript-registry.ts):
```
App xyz.tinycloud.tinychat, space "applications".
Meetings: SQL db xyz.tinycloud.tinychat/connectors, table connector_meeting(id, source, source_id, title,
 started_at, duration_secs, organizer_email, participants JSON, summary_overview, summary_action_items,
 keywords JSON, meeting_type, metadata JSON, created_at, updated_at). NEVER select metadata (can embed whole
 transcripts); page with LIMIT and stay under 1 MiB.
source values: fireflies, google-meet, tinycloud-transcriber, exo-local, exo-merged (members in metadata.merge.members;
 hide members), exo-voice-note, exo-upload, exo-voice-note-dup (archived duplicate, ignore).
Transcript body: KV key xyz.tinycloud.tinychat/connectors/<source>/transcript/<source_id>, JSON array of
 {index, speaker_name, text, start_time, end_time}.
Voice notes: table voice_note_transcript(source_id, rev, hash, body_key, outcome, preview, ...). Readable only when
 outcome='transcribed'; body at body_key (.../exo-voice-note/transcript-rev/<source_id>/<hash>).
Threads (private; do not read unless asked): db xyz.tinycloud.tinychat/threads.
```
(Meeting-pack tools would hide most of this; hints are still needed for the generic SQL/KV fallback and for voice notes/uploads, which the tool contract excludes today: tool-contract.ts MEETING_SOURCES, TC-995. Voice notes in/out is spec open Q8.) The 3-db `meeting-db` schema (details/summaries/transcripts) has no production writer yet [TC findings]; when it ships, hints change with it, which is why hints belong to the app.

## 3. Migration: Eliza duties and MCP equivalents

| # | Eliza duty [eliza, packages/eliza-service] | MCP equivalent | Gap |
|---|---|---|---|
| 1 | `/health`, `/capabilities` (contractVersion 2, buildRevision) | `tinycloud_status`; MCP `/healthz` | Capabilities negotiation: replace with pinned `@tinycloud/mcp` version in backend config. |
| 2 | `/sessions` connect/liveness/disconnect + grant store (`eliza-delegations` space) | `tinycloud_connect` + `authority_required` + per-tenant store | Different model; liveness probe = bootstrap validity KV list (2 s, 30 s cache). |
| 3 | `/tasks` SSE runner (4 rounds, 16 tool attempts, 300 s, retry) | None | **Gap: backend must own it** (reuse legacy loop + `meeting-eval`). |
| 4 | `tinycloud_find_meetings` | pack tool needed | Gap |
| 5 | `tinycloud_read_meeting` (focus summary/actions/decisions/speaker/transcript) | pack tool needed | Gap |
| 6 | `tinycloud_search_transcripts` (<=12 meetings, 3 concurrent bodies) | pack tool needed | Gap |
| 7 | `tinycloud_list_meeting_actions` (range scope) | pack tool needed | Gap |
| 8 | `web_search` (Tavily, `TAVILY_API_KEY`) | None | **Gap**: backend-side tool; not an MCP duty. |
| 9 | Evidence contract v2: `outcomes[]`, `coverage.support`, omission reasons, <=16,000 chars/tool result, <=12,000/outcome, 500-row scan, 1 MiB body -> `size_limit` (`meeting-evidence.ts:17-24,347-408`) | None | **Gap**: pack must emit the same JSON, or backend re-derives. |
| 10 | TC-2163 SQL projection: never select raw `metadata`; `json_object` of MARKER_KEYS + transcript_count + merge.members<=128 B; clipped columns; `SQL_PAGE_BYTE_BUDGET`=0.75 MiB paging; combined-member exclusion pages (`transcript-registry.ts:246-283,355-392,423-444`); fetch wrapper 1 MiB cap (`transcript-transport.ts:6,64-112`) | `tinycloud_sql_query` with caller `maxBytes`/100,000-char cap | **Gap**: generic SQL cannot enforce "no raw metadata + byte-budget paging" server-side; port to the pack or the model will hit the cap (3 MB meeting list noted in `transcript-fetch.md:25`). |
| 11 | Answer validation/repair/fallback: citations `[M1]`,`[M1:S]`,`[M1:A2]`,`[M1:E3,Speaker,hh:mm:ss]`, coverage section, false-"all N" rejection, one repair round (`tasks/answer.ts:73-195`, `evidence.ts:267-369`) | None | **Gap: move into backend** (legacy equivalent in `backend/src/transcripts/meeting-answer.ts`, `meeting-evidence.ts`). |
| 12 | Per-room selection state, calendar scope clarification (`transcript-registry.ts:62,153-180`, `runner.ts:181,299,340`) | None (MCP stateless per request) | **Gap: backend or client** holds it. |
| 13 | Voice-note commit-index readability, combined-meeting hiding | pack tool | Gap (see 10). |
| 14 | `RUN_ARTIFACT_SKILL` stub for Artifactory app | N/A | Unverified whether Artifactory calls it in prod; confirm before shutdown. |
| 15 | `/messages` + memory plugin (tables `long_term_memories`, `session_summaries` in `xyz.tinycloud.eliza/memory`) | None | Not used by TinyChat; **data decision**: leave or delete the user data (spec D9-D10 leaves it unrevoked). |
| 16 | Scheduling/cron/push/email | n/a | **None found in eliza-service** (grep'd); no schedule duties to migrate. |
| 17 | Per-service secret auth + entityId derivation | OAuth token + tenant HMAC | Replaced. |
| 18 | Service logging: no content logged | MCP logs tool/code/duration | Parity. |

Other Eliza consumers: none found outside TinyChat except the possible Artifactory stub (grep of repositories/ for the service env names matched only tinychat and tinycloud-agents).

## 4. Cutover order, rollback, shutoff

**Order.**
1. Prereqs (Artifacts): single-approval + OAuth token for TinyChat; released (not master) `@tinycloud/mcp` with meeting pack; hosted deploy (manual Phala workflow `mcp-image.yml`, requires Amos relay of Sam's "deploy"; hosted-mcp-deploy note) plus rollback digest.
2. Backend `McpToolClient` + moved validation, behind `MCP_CHAT_ENABLED` + `MCP_CHAT_TEST_ACCOUNTS` (mirrors `ELIZA_TASKS_ENABLED`/`_TEST_ACCOUNTS`, `docs/deployment.md:268-269`). Eliza untouched.
3. Dual-run offline: run the same prompts through both paths against the same test accounts; compare structured outputs. Reuse `meeting-eval.ts` (30 scenarios x 3 paraphrases x 3 repeats; per-model pass required), `meeting-contract-parity.check.ts` (re-point to the pack's schemas), Eliza `tasks/answer.test.ts`, `orchestration.test.ts`, `transcript-registry-listing.test.ts` fixtures (501 rows x ~50 KB metadata), voice-note and combined-meeting tests. Compare: same meeting refs, same citations, coverage state, no 413/size errors, answer deterministic sections.
4. Ramp: test accounts -> 10% -> 100% with `ELIZA_TASKS_ENABLED` still true as the fallback. Silent shadow (MCP run, discard) is possible but doubles RedPill cost and exposes content twice; prefer eval + test accounts [judgement].
5. New sign-in flow: single approval replaces "Connect private agent" (`AgentEnablementBanner.tsx`, `mintAgentSessionViaFreshSignIn`). Existing connected users: keep Eliza path until they reconnect (spec acceptance :151-159: "previously-connected users keep working").
6. Delete Eliza code/env (agent triad `AGENT_DID`,`ELIZA_SERVICE_URL`,`ELIZA_SERVICE_SECRET`, `elizaAdapter.integration.test.ts` and `elizaFinalization.compatibility.test.ts` which import `../tinycloud-agents`, `test/agent-flow-manual.ts`).
7. Switch Eliza off (see gate), leave user data untouched for 30 days, then decide on `xyz.tinycloud.eliza/memory` and `eliza-delegations` data with Sam.

**Rollback.** Flag flip `MCP_CHAT_ENABLED=false` + backend restart (env changes need restart: `docs/deployment.md:360-366`). Eliza stays deployed and warm until the gate passes. MCP deploy rollback by image digest (js-sdk#500; last known good digest recorded in the hosted-mcp-deploy note: re-verify before quoting). **Caveat:** per the memory note a version rollback restores service but tenants hit `authority_required` and must re-approve; so rollback of the MCP is not a user-transparent rollback. The chat-side flag is the real rollback.

**"MCP live" gate (all measurable).**
- Pinned released `@tinycloud/mcp` version deployed; `tools/list` on `/mcp` shows the meeting pack (verify; live tools/list was not called by the scout).
- Eval: >=95% of scenarios pass per offered model, no regression vs Eliza baseline on citation validity/coverage rules (threshold is a proposal for Sam); 0 size-limit errors on the 501-row fixture.
- p95 turn latency <= Eliza baseline + 20% (proposal); error rate on test accounts <0.5% over 7 days.
- >=N real accounts (proposal 10) completed single-approval connect, incl. reconnect after revoke and after MCP restart.
- Opus gate checklist signed.
- Eliza off: 7 consecutive days at 100% with 0 requests to `eliza.tinycloud.xyz`, Artifactory confirmed not a caller.

**Opus gate checklist.**
1. Delegation custody: plaintext `key.json`/`session.json` per tenant (remote-store.ts:1038-1048); confirm encrypted persistent volume on Phala/dstack (unverified); single replica; 30d lifetime. Blast radius: a compromised MCP holds every connected user's 30d grant; mitigate with scope minimisation (no memory/admin), shortest practical expiry, rotation, node-side revocation drill.
2. Decrypt in TEE: decrypt grant is whole-network `:default` (decrypt-boundary.md); do not request it for chat unless data is encrypted; named keys unshipped.
3. Attestation: no attestation endpoint/quote in the MCP code [master grep]; compose mounts dstack.sock; Phala logs disabled. "Open source in a TEE" claim is only verifiable by users if image digest <-> source <-> quote is published. Required before claiming trust model externally.
4. Revocation: no MCP revoke route (TC-1156); OAuth revoke does not revoke delegation; test node-side revoke -> `authority_required` re-prompt end-to-end; add a Disconnect button that points to account.tinycloud.xyz/delegations or ship the revoke route.
5. Logging: server logs only tool/code/duration (README). Verify live config; backend must not log tool results or prompts; RedPill retention; client transcripts retain tool results (README warning). Ingress logs unchecked.
6. Tenant binding: OAuth `sub` -> `owner_dids`; callback checks signer = owner (ApprovalOwnerMismatchError); backend must key per-user tokens strictly by the authenticated session (the old `entityId` trust issue in Eliza is replaced).
7. Origin allowlist is `claude.ai`, `chatgpt.com`, and no-Origin requests are allowed (http.ts:325-330): server-to-server call from the backend works but confirm intended.
8. Prompt injection from meeting content leaking via tools: `sql_execute`/`kv_put` must not be exposed to the chat model in v1 (allowlist read-only tools in the backend).

## 5. Owners and ETAs

Ranges are my estimates [INFERENCE]; none verified with the leads.

| Step | Owner | ETA | Depends on |
|---|---|---|---|
| A. Spec single-approval scope + OAuth client for TinyChat (OpenKey) | Artifacts lead (+OpenKey) | 3-5 d | Sam decision on scope (write/decrypt) |
| B. Meeting tool pack in `packages/mcp` incl. TC-2163 projection, evidence JSON | Artifacts lead | 1.5-3 wk | A (grant shape), Eliza `meeting-evidence.ts` as reference |
| C. Released MCP version + hosted deploy + rollback drill | Artifacts lead, Amos | 2-5 d after B | Sam's "deploy" + DNS write approval; Phala/Cloudflare keys (stale 2026-10-12 per note; re-verify) |
| D. Backend MCP client + move answer validation/loop, flag, tests | Exo lead | 1.5-2.5 wk (parallel to B using the mocked pack contract) | B contract |
| E. Single-approval UI replacing Connect agent; hints file; drop memory grant | Exo lead | 4-7 d | A, D |
| F. Dual-run eval + ramp | Exo lead | 1 wk + 7-day soak | B, C, D |
| G. Opus gate | Opus/Sam | 2-3 d review | evidence from A-F |
| H. Eliza off + code/env deletion + data decision | Exo lead; Sam for data | 2-3 d after soak | G |

Critical path ~4-6 weeks to Eliza off. Only Sam/Amos/Naomi can unblock: Sam: "deploy" and DNS approval, scope of the single grant (write? decrypt?), OpenKey changes, data fate of `xyz.tinycloud.eliza/memory`. Amos: release/deploy slot and fresh deploy keys via `release-keys`. Naomi: informed before any MCP dispatch (note says tell Naomi first).

## Open questions
1. Meeting pack in the MCP (recommended) vs generic SQL+KV with hints? The latter loses TC-2163 safeguards.
2. Does chat write via MCP at all in v1 (threads are browser-written today)? Recommended: no.
3. Is decrypt actually required? Today's data is plaintext; if connector data will be encrypted, when? Needed to size the grant.
4. Voice notes/uploads in chat tools (spec Q8) and memory for all users (spec Q3).
5. Does the MCP's reported version in production match master? The scout could only bound it to >= #653 (2026-10-23); the memory note's "0.3.0 deployed" is likely stale. Check `tools/list` with a token.
6. Is Artifactory a live Eliza consumer?
7. Who runs `web_search` (Tavily key lives in Eliza)? Move key to backend.
8. Streaming: backend streams the model, MCP calls are unary; fine, but confirm no tool call exceeds Eliza's 10 s meeting deadline.

## 6. Eliza executor: what the MCP path must reproduce (verified; replaces earlier [INFERENCE])
Read in tinycloud-agents ed320bd, `packages/eliza-service/src/tasks/` (the local checkout is stale and lacks it). `evidence.ts` header says it was "relocated from TinyChat's narrow meeting-evidence helpers", and TinyChat still carries the legacy copy (`backend/src/transcripts/{meeting-evidence,meeting-answer,legacy-meeting-projection,legacy-meeting-date-scope,meeting-turn}.ts`). So brief item 13 is "port + reconcile", not greenfield; the Eliza copy is the newer one.
1. **Planning loop** (`runner.ts:172-355`): <=4 provider rounds, <=16 tool attempts, one retry only for transient errors per canonicalised call key, repeats -> `tool_repeat_limit`; 300 s deadline; forced no-tools last round; clarification when a relative date is asked without `calendar{localDate,timeZone}` (`runner.ts:181`, `calendar.ts:34-52`).
2. **Metadata vs content classification** (`answer.ts:23-32` `isMetadataRequest`, regex): content questions need at least one non-metadata citation.
3. **Evidence ledger and packing** (`evidence.ts`): run aliases `M1..M12` (max 12 meetings), kinds metadata/summary/notes/action/transcript_excerpt/body_excerpt, items <=4,000 chars, packed <=48,000 chars and <=70% of model context (`:267-269`), `coverage{support sufficient|limited|none, omissionReasons}`, `discovery{matchedCount, countKind exact|lower_bound, scanLimited, orderProven, nextCursor}`, body states (present, missing, size_limit, access_denied, ...).
4. **Clean-context synthesis** (`answer.ts:34-62`): only latest question + resolved date scope + current-run evidence + public sources (no history, no memory); evidence is data; citations are required output: `[M1]`, `[M1:S]`, `[M1:A2]`, `[M1:E3, Speaker, hh:mm:ss]`.
5. **Validation + repair** (`answer.ts:64-195`): codes `empty_answer, unknown_meeting_citation, missing_meeting_citation, missing_content_citation, no_usable_evidence, coverage_conflict, internal_reference`; one repair round gets the codes but not the rejected draft; else deterministic safe fallback; service-appended `### Coverage` and `### Public sources`; rejects "read all N meetings"/exhaustive claims over bounded evidence and raw storage refs.
6. **Recap-only is a legitimate answer** when body is `not_requested` (stored overview/actions), worded as recaps.
7. **Tool-side retrieval semantics** (`transcript-registry.ts`, `tinycloud-search-transcripts.ts`): opaque `meetingRef`; source allowlist (fireflies, google-meet, tinycloud-transcriber, exo-local, exo-merged, exo-voice-note); `exo-merged` hides members; voice notes only when committed `transcribed` in `voice_note_transcript` with the exact `body_key`; per-room selection state; 10 s tool deadline; <=16,000-char tool JSON; **TC-2163 byte-bounded paging** (never select raw `metadata`; `json_object` projection; `SQL_PAGE_BYTE_BUDGET` = 0.75 MiB). Generic `sql_query` cannot enforce this: the Exo wrapper must emit those exact SQL strings and set `maxRows`/`maxBytes` itself, and stay under the MCP's 100,000-char hosted cap (stricter than Eliza's 1 MiB, so pages shrink; the 501-row fixture needs retesting).
8. **Delegation lifecycle**: fail closed on revoked/expired (`delegation_required|expired|revoked` -> `delegation_error`, public-only fallback). MCP equivalent is `authority_required` + `approval.url`; the backend must map it to the same frame and UI.
Reusable regression assets: Eliza `answer.test.ts`, `orchestration.test.ts`, `runner-reliability.test.ts`, `transcript-registry-{listing,combined,voice-notes}.test.ts`; TinyChat `backend/scripts/meeting-eval.ts` (swap its synthetic Eliza fixture for an MCP-backed one).

## 7. Open dependencies on MCP-side work (for Naomi to size/own)
Sizes follow the brief's section 5 table, adjusted for this plan. [n] = brief item number.
| # | MCP-side item | Why chat needs it | Size | Blocks |
|---|---|---|---|---|
| 1 | Single-approval connect: `tinycloud_connect {appId}` builds one bootstrap request from the app's registered manifest (allowlist-validated) so one OpenKey page grants bootstrap + app read tier [1] | Sam's "one approval"; today bootstrap is account-read only and each capability is another OpenKey page (`remote-store.ts:32-45,203-300`) | M-L | Steps E, F; all user-facing rollout |
| 2 | Read vs read+write tier flag in that bundle [2] | v1 read-only without a second page; writes opt-in | S | any write; injection posture |
| 3 | OpenKey OAuth client for Exo (`tinycloud:mcp`, `owner_dids` claim, server-side refresh) [11] | No bearer exists for TinyChat; MCP rejects without `owner_dids` (`oauth.ts:459-466`) | M (OpenKey) | every backend->MCP call |
| 4 | Hint carrier: manifest `hint` (<=600 chars), returned by `account_applications_list`/`knowledge_list`, per-tenant `instructions` composer (2 KB) [3] | App hints; `validateManifest` may reject unknown keys [INFERENCE, check sdk-core] | M | Not blocking: hints ship via existing `knowledge_read` bundle |
| 5 | Paging/large payloads: `truncated`/`nextCursor` for `sql_query`, documented row cap, review the 100k hosted cap [5] | Listings/transcripts exceed it (`results.ts:42-58`) | M | long meetings; TC-2163 parity |
| 6 | Read-only surface or scope filtering for chat (no `kv_delete`, gated `sql_execute`/`apps_write`) [4] | Injection defense in depth; backend allowlist is first line | M | enabling writes; Opus gate 8 |
| 7 | `/attestation` bound to MCP identity (dstack.sock already mounted) [8] | Q(c); Opus gate 3 | M | external "TEE-private" claim; ramp |
| 8 | Multi-DB convenience / one approval for listed DBs [7] | Only once 3-DB format has writers | M | 3-DB migration, not v1 |
| 9 | Search helper (FTS5/LIKE) [6] | Eliza `search_transcripts` scans <=500 rows; `LIKE` via `sql_query` is the v1 stand-in (node FTS5 unverified) | M | search parity |
| 10 | Revoke tool/route + user-visible audit log, no args [9] | Opus gate 4; trust story | M-L | launch only if required |
| 11 | Per-tenant rate limit/backoff + metrics [10] | No MCP-side limiting today | S-M | ramp past test accounts |
| 12 | Released, pinned `@tinycloud/mcp` + deploy slot + rollback-digest drill | master is 0.8.3-beta.15 and churning; deploy is manual, Amos/Sam-gated | S (process) | Step C |
| 13 | HA / shared state [14] | single replica SPOF | L | not v1 (accept; flag is the rollback) |
Exo-side (not MCP): knowledge bundle + manifest `knowledge:true` [12] (S); executor port [13] (L, section 6).

## 8. Positions on Sam's five questions
The plan adds Q6 and removes none.
- **(a) Direct vs Exo four-tool contract: keep Exo's four-tool contract over the MCP.** The executor (section 6) needs typed results (`meetingRef`, coverage, byte-budgeted SQL) that a model calling raw `sql_query` cannot honour; the model never sees write tools; the 100k cap/TC-2163 paging is enforced in one place. Cost: a wrapper (L, mostly a port). The MCP stays general. Revisit only if a v2 pack moves semantics MCP-side.
- **(b) Chat read-only in v1: yes.** Threads are already browser-written (`threadStore.ts`), no chat feature needs server writes, writes are the injection path, and the read tier (item 2) avoids a second prompt. Add a write tier later with per-call user confirmation.
- **(c) `/attestation` before launch: required before any external "TEE-private" claim and before ramp beyond test accounts/internal users; not required for internal dual-run.** The MCP becomes the aggregate holder of every connected user's delegate key on one replica with plaintext 0600 files (`remote-store.ts:1038-1048`) and no verifiable deployment (no attest|quote in `src/`). Trust was accepted by Sam; attestation makes it checkable. Cost is M and dstack.sock is mounted.
- **(d) Losing backend-only content: OK, after a count.** Backend ingest is dark by default (`CONNECTOR_BACKEND_INGEST_ENABLED=false`, `docs/deployment.md:284`), cohort-only [INFERENCE: cohort size unverified]. Before switching Eliza off, count addresses with content-store rows; if >0, export to the user's space or notify them. Eliza reads the user's connectors db, not the content store (`transcript-registry.ts` queries only `connector_meeting`/`voice_note_transcript`), so today's Eliza chat does not see that content either [verify the content store has no reader in Eliza].
- **(e) 30-day owner-renewed delegation: yes for v1.** Matches today's 29-day grant (`agentDelegation.ts:35-42`) and OpenKey's max; expiry yields one re-approval link (`remote-store.ts:226-260`), surfaced through the existing Reconnect banner. No auto-renewal until revoke + audit exist (item 10): longer lives enlarge aggregate blast radius. UX: warn at day ~25 [proposal].
- **New Q6: first approval covers `connectors` (production today) or the 3-DB format (no writers yet)?** Recommend `connectors` for v1 so chat is not blocked on the 3-DB migration; re-scope the grant when writers ship.
