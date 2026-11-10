# Calendar autojoin implementation

Implemented from `docs/tinychat-calendar-autojoin-implementation-plan.md` on 25 September 2026,
without Smithers. Changes are in two feature worktrees; the original dirty checkouts were preserved.

| Repository | Worktree | Branch / base |
| --- | --- | --- |
| Tinychat | `/home/roman/projects/development/worktrees/tinychat-calendar-autojoin` | `feat/calendar-autojoin`, based on `f67bf084` |
| Transcription | `/home/roman/projects/development/worktrees/transcription-calendar-autojoin` | `feat/calendar-autojoin-lookup`, based on `2cdaabd4` |

The backend now owns durable connection, occurrence, and permanent sent-marker state in its shared
KV lane. Startup and periodic reconciliation discover eligible events, freeze exact create intents,
recheck consent and time before each POST, repair ownership, and recover uncertain creates through
the project's read-only idempotency lookup. Disabled and replaced accounts keep lookup/stop recovery.

Google autojoin uses explicit custody consent, PKCE, standard Google OIDC signature/issuer/audience/
expiry validation, a transaction nonce, server-confirmed scopes, encrypted refresh tokens, and
generation checks. Browser-only Google connections retain their existing behavior; reconnect blocks
unattended access until rebound. Disable removes server custody; Disconnect additionally attempts
revocation and removes browser credentials while preserving recordings.

The existing Google connector exposes the toggle, status, scan time, consent, and outcomes. A single
app-shell library hook imports completed owned recordings while the user is unlocked, independently
of Sources navigation, and repairs SQL-success/KV-failure imports without overwriting existing titles
or transcript bodies. Empty transcripts are explicitly persisted as `[]`.

## Validation

- Workspace package build, backend TypeScript check, frontend TypeScript/production Vite build,
  transcription TypeScript check, and both repositories' diff whitespace checks passed.
- Final focused backend run: **194 passed**, covering OAuth/OIDC, credential lifecycle, state,
  worker recovery, Calendar policy, transcription client, manual transcriber, rate limits, and API
  contracts. Worker tests include write failures, lost responses, disable during POST, delayed commit
  after re-enable, ownership repair, account replacement, recurring moves, full Retry-After, stale
  Google grants, permanent rejection, four-operation concurrency, and no create after cutoff.
- Transcription API/hash/lookup tests: **25 passed**, including local PostgreSQL/Redis integration,
  project isolation, lookup misses, and no lookup writes/enqueues.
- Frontend full run before the final UI race regressions: **1,173 passed, 4 skipped, 4 failed**.
  All four failures were reproduced against unmodified `HEAD`; they are existing source-string
  assertions for App/connector/encryption-grant code. Feature tests, partial-import tests, and builds
  passed. Final focused runs also cover sticky revoke failures and stale status responses.
- Backend full run: **1,830 passed, 7 skipped, 7 failed**. Failures were confined to existing agent
  socket tests. Baseline full run: **1,751 passed, 7 skipped, 5 failed** in those same socket suites;
  isolated baseline and changed-code runs reproduce the same three persistent cancellation/
  backpressure failures, with varying timing failures in full runs. The new backend feature tests
  pass in isolation and in the full run. Skips require an absent sibling Eliza checkout.

No deployment, real Google account authorization, host admission smoke, or deployed retention
verification was performed. [Operations and smoke instructions](calendar-autojoin-operations.md)
document the required Google configuration, durable storage, single-writer replacement, retention
check, and browser-closed/disable/return-time-import smoke.
