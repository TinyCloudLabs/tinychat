# MCP chat cutover (TC-2196)

Exo part: **S-M, hours.** It starts when the MCP side below is ready (Artifacts lead, about a day, theirs). `[INFERENCE]` = not verified in source.

## Decisions this plan follows (Sam, TC-2196)
- Chat's only data path is the TinyCloud MCP; Eliza is dropped once MCP chat is live (21:00Z).
- Read-only v1 ("b" answer); 30-day approval is fine (22:30Z).
- Exo keeps its four tools (find / read / search / list_actions) over the MCP's own `tinycloud_sql_query` and `tinycloud_kv_get` ("a" answer).
- App hints are good: they ride the MCP knowledge bundle.
- Sign-in is TinyCloud-native: no OpenKey change.
- Everyone switches when the old assistant goes off and approves once (Q2).

## Exo plan
1. **Sign-in grant.** At sign-in Exo delegates to the published MCP identity with `tcw.delegateTo` (`frontend/src/lib/agentDelegation.ts:227`; `delegateDID` is already a parameter, `:195,:228`): read-only on db `xyz.tinycloud.tinychat/connectors` (SQL read) and KV `xyz.tinycloud.tinychat/connectors/` (get, list), space `applications`, 30 days, one approval. This replaces today's two grants (memory + transcripts); the memory grant is dropped.
2. **Chat backend calls the hosted MCP** with that permission, behind `MCP_CHAT_ENABLED` plus a test-account list (same pattern as `ELIZA_TASKS_ENABLED` / `ELIZA_TASKS_TEST_ACCOUNTS`, `docs/deployment.md`). Exo's tool schemas stay (`backend/src/transcripts/tool-contract.ts`).
   - Tools run over `sql_query` / `kv_get` against `connector_meeting`, `voice_note_transcript` and `connectors/<source>/transcript/<source_id>`.
   - **TC-2163 paging:** never select raw `metadata` (it can embed ~50 KB of transcript per row); use the `json_object` projection and byte-budgeted pages from Eliza `transcript-registry.ts:246-283,355-392`. The hosted MCP replaces any result over 100,000 serialized characters with an error (js-sdk `packages/mcp/src/results.ts:42-58`), so pages stay smaller than Eliza's 1 MiB.
   - **Answer-validation port** from Eliza `tasks/answer.ts` and `tasks/evidence.ts`: evidence ledger `M1..M12`, citations `[M1:E3, Speaker, hh:mm:ss]`, validation codes with one repair round and a safe fallback, Coverage section, recap-only answers, calendar clarification. Starting point: `backend/src/transcripts/meeting-*.ts`.
   - `web_search` (Tavily) moves to the backend.
3. **Hints** as an Exo knowledge bundle (`knowledge/index.md`, `app.md`, `tables/*.md`) from `agent-skills/tinychat-retrieval/references/meetings.md`: the db/table names above, `source` values (`fireflies`, `google-meet`, `tinycloud-transcriber`, `exo-local`, `exo-merged`, `exo-voice-note`; ignore `exo-voice-note-dup`), the voice-note rule (readable only when `voice_note_transcript.outcome = 'transcribed'`, body at its `body_key`), and "never select `metadata`; page with LIMIT".
4. **Cutover.** Flag on for Sam's account and one test account. Ask a few real meeting questions (synthetic or test data). Then Eliza off; everyone approves once at sign-in. Eliza stays deployed until then. Rollback = flip `MCP_CHAT_ENABLED`.
5. **One short Opus look** at the delegation handoff only (Naomi's ask): who signs what (the user's passkey session signs a delegation to the MCP identity), audience (the MCP identity), capabilities (read on `connectors` only), expiry (30 days), where it lives (the MCP's per-user store, 0600 files), and how it is removed (flag off, or the owner revokes the delegation).

## What Exo needs from the MCP side (the only dependency)
1. **The MCP's identity:** its DID, and where it is published (for example a well-known route or the server's discovery metadata). Today no MCP DID is published; per-tenant DIDs are returned only after an authenticated `tinycloud_connect` (`packages/mcp/src/remote-store.ts:191-197,729-737`).
2. **The accepted delegation shape and capabilities:** a UCAN from `tcw.delegateTo` (as in `agentDelegation.ts:227`), which resources/actions it must contain (SQL read on `xyz.tinycloud.tinychat/connectors`; KV get/list on `xyz.tinycloud.tinychat/connectors/`), and how Exo hands it over (an intake route and the credential Exo's backend uses to call the MCP per user).
3. **How the MCP reports an expired, revoked or unaccepted delegation** to the caller (an error code in the tool result, like today's `authority_required`), so Exo can show the existing "Reconnect" prompt.

## Eliza
Nothing from Eliza's `/sessions`, `/tasks`, `/tools`, `/messages`, memory plugin or `RUN_ARTIFACT_SKILL` stays. The backend's transcript-writer grant (`backend/src/routes/delegations.ts:28,129`) targets the backend, not Eliza [INFERENCE: nothing else depends on Eliza]; the exo-sync grant (`routes/exo-grant.ts:40,126`) goes away with Eliza per Sam. Confirm Artifactory is not a live caller of `/tools/RUN_ARTIFACT_SKILL` before shutdown.

## Question for Sam
- **Old assistant's memory data** (`xyz.tinycloud.eliza/memory`, `eliza-delegations`): default is leave it unused; delete only if you say so.

Details: TC-2196
