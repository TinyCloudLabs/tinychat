# MCP chat cutover (TC-2196)

Estimates are S/M/L only. Overall: **M, hours to about 1-2 days**, assuming the OpenKey OAuth client card is approved. `[INFERENCE]` = not verified in source.

## Decisions this plan follows
- Chat's only data path is the TinyCloud MCP; Eliza is dropped once MCP chat is live (Sam, 21:00Z).
- Read-only v1: chat answers questions over meetings; no writes (Sam, "b" answer).
- 30-day owner-approved delegation is fine (Sam, 22:30Z).
- Exo keeps its four tools (find / read / search / list_actions) and runs them over the MCP's own `tinycloud_sql_query` and `tinycloud_kv_get`, with TC-2163 byte-bounded paging and the answer-validation port (Sam, "a" answer).
- App hints ride the existing MCP knowledge bundle (`tinycloud_knowledge_read`), not new MCP work (Sam: "app hints are good").

## Path (v1)
1. **Backend wrapper** in `backend/src/transcripts` executes the four tools over the hosted MCP, read-only, against db `xyz.tinycloud.tinychat/connectors` (`connector_meeting`, `voice_note_transcript`) and KV prefix `xyz.tinycloud.tinychat/connectors/`. Exo's tool schemas are unchanged (`backend/src/transcripts/tool-contract.ts`). Size: L of the work, mostly a port.
2. **TC-2163 paging in the wrapper.** Never select raw `metadata` (it can embed ~50 KB of transcript per row); use the `json_object` projection and byte-budgeted pages from Eliza `transcript-registry.ts:246-283,355-392`. The hosted MCP replaces any result over 100,000 serialized characters with an error (js-sdk `packages/mcp/src/results.ts:42-58`), which is stricter than Eliza's 1 MiB, so pages are smaller.
3. **Answer-validation port** from Eliza `tasks/answer.ts` and `tasks/evidence.ts` (evidence ledger `M1..M12`, citation syntax `[M1:E3, Speaker, hh:mm:ss]`, validation codes + one repair round + safe fallback, Coverage section, recap-only answers, calendar clarification). TinyChat's legacy copy in `backend/src/transcripts/meeting-*.ts` is the starting point; the Eliza copy is newer.
4. **Hints** as an Exo knowledge bundle written by the app (`knowledge/index.md`, `app.md`, `tables/*.md`) from the rules in `agent-skills/tinychat-retrieval/references/meetings.md`. Content: db and table names above, `source` values (`fireflies`, `google-meet`, `tinycloud-transcriber`, `exo-local`, `exo-merged`, `exo-voice-note`; ignore `exo-voice-note-dup`), transcript key `connectors/<source>/transcript/<source_id>`, the voice-note rule (readable only when `voice_note_transcript.outcome = 'transcribed'`, body at its `body_key`), and "never select `metadata`; page with LIMIT". Size: S.
5. **Flag.** `MCP_CHAT_ENABLED` with a test-account list (same pattern as `ELIZA_TASKS_ENABLED` / `ELIZA_TASKS_TEST_ACCOUNTS`, `docs/deployment.md`). Eliza stays deployed and warm.
6. **Delegation:** one OpenKey OAuth token per user held by the backend, then the MCP's existing connect/approval for read access to `connectors`. See "Questions for Sam".

## Acceptance (Sam's)
- Flag on for Sam's account and one test account only.
- A quick answer check on a few real meeting questions, using synthetic/test data.
- Eliza off when it works.
- Rollback = flip `MCP_CHAT_ENABLED` (backend restart; Eliza is still deployed).
- One short Opus look at the delegation handoff only (Naomi's ask); no other review gate.

## The delegation handoff (for the Opus look)
- **Hosted MCP identifies the user by an OpenKey OAuth JWT** (scope `tinycloud:mcp`, `owner_dids` claim, introspection): js-sdk `packages/mcp/src/http.ts:93-97,296-306`, `oauth.ts`.
- **It takes a delegation only through OpenKey's `/connect/callback`**, a full signed-login session bound to the tenant's own session key and signed by an owner DID (`remote-store.ts:437-449,560-585`). `tinycloud_auth_import` is local-only (`tools.ts:166-177`). So Exo's existing grants cannot be handed to it.
- **Unblock without OpenKey code:** OpenKey allows dynamic client registration with `tinycloud:mcp` in the default scopes (OpenKey `apps/api/src/auth.ts:284,296`, `oauth-config.ts:32-33`). It is still a new OAuth client, so it needs Sam's card.
- **Who signs what.** The user signs in at OpenKey (OAuth consent, existing page), then approves one delegate page for read on `connectors` (SQL read + KV get/list) to the MCP tenant's session DID, signed by the user's identity. The backend holds the OAuth access/refresh token per user server-side; the MCP holds the delegation (30 days, owner-renewed, 15-minute approval link).
- **Revoked** by removing the flag, the backend's token record, or the MCP delegation at account.tinycloud.xyz/delegations (README).

## What the backend already stores today (Sam's delegation question)
- **Transcript-writer grant:** `backend/src/routes/delegations.ts:28,129`. Delivery eligibility is `transcriptEligibility` (`backend/src/index.ts:569-571`), driven by `transcriptDeliveryConfig`, not by `CONNECTOR_BACKEND_INGEST_ENABLED` as far as I read.
- **Exo-sync grant:** `backend/src/routes/exo-grant.ts:40,126`, mounted only while `exoCapabilitiesEnabled` is true (`index.ts:750-755`); it reaches two Exo KV prefixes only. It goes away with Eliza.
- Neither is a grant to the MCP; they target the backend DID and cannot be used by the MCP.

## Eliza duties and what replaces them
| Eliza duty | After cutover |
|---|---|
| `/sessions` grant store and liveness | Replaced by the MCP's own delegation and OAuth token |
| `/tasks` loop and `/tools/*` | Backend wrapper loop over MCP `sql_query`/`kv_get` |
| 4 meeting tools + evidence contract | Same tool schemas, ported executor (steps 1-3) |
| `web_search` (Tavily) | Moves to the backend (needs `TAVILY_API_KEY`) |
| `/messages` + memory plugin, `RUN_ARTIFACT_SKILL` stub | Not used by TinyChat; dropped. Confirm Artifactory is not a live caller |
| Scheduling / push / email / cron | None exist in Eliza |

## Questions for Sam (one line each: what the user sees / cost)
1. **OpenKey OAuth client for Exo.** User sees OpenKey's consent screen, then the delegate page: 2 pages once vs 1 today; OpenKey is frozen so it needs your card; no OpenKey code change.
2. **Single-approval read-tier bundle** replacing "Connect private agent": user sees one approval page instead of two; costs M-L MCP work. Without it, v1 ships with the two pages above.
3. **Users already connected:** keep Eliza until they reconnect, force reconnect, or set a cutoff date. Recommendation: keep Eliza until reconnect, then off.
4. **`xyz.tinycloud.eliza/memory` data and `eliza-delegations` records:** leave unused, or delete? Also count addresses with backend content-store rows (`services/content-store.ts`; dark behind `CONNECTOR_BACKEND_INGEST_ENABLED`, default false) before Eliza is off.
5. **First approval covers `connectors` (production today) or the 3-DB format** (`details/summaries/transcripts`, `docs/meeting-storage.md`; no writer exists yet)? Recommendation: `connectors`.

## Later, only if a defect appears
Hint carrier on the manifest and per-tenant instructions composer; `nextCursor` paging on `sql_query`; read-only surface/scope filtering for chat; multi-DB approval; a search helper (FTS5/LIKE); HA/shared state. Not dependencies.

Details: TC-2196
