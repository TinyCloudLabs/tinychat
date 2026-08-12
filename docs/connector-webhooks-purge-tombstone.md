# Connector webhooks — what the purge tombstone actually covers

Status record for design §6.2 / §4.8, written because §9.1's T1 row claimed more than the code
delivered. Read with `backend/src/services/connector-drain.ts` (`isTombstoned`) and
`backend/src/routes/connector-webhooks.ts` (`POST /purged`).

## 1. The watermark now reads the provider stamp and nothing else

`isTombstoned` compares `sourceTimestamp` against `ledger.purgedThrough`. It used to fall back to
`receivedAt` when the delivery carried no provider timestamp, and that fallback made the watermark
**inert** for the legacy `{meetingId, eventType}` shape (§4.5), which carries no timestamp at all:

- `receivedAt` is refreshed on every (re-)delivery, and
- a purge **clears the pending queue** (§6.2),

so every post-purge item of that shape is freshly enqueued with a `receivedAt` of *now* — on the
safe side of the watermark by construction. For legacy-shape deliveries both controls T1 leans on
were therefore off: the ±24 h freshness window is skipped for that shape *by design*, and the
watermark could never fire. What was left was `recentIds`, hard-capped at 200 and described by
§6.2 itself as forensics. A captured signed delivery resurrected a purged meeting as soon as its
id aged out of that list.

**Rule now:** an ABSENT provider stamp is treated exactly like an unparseable one — not evidence
of safety. With a ledger present, a timestamp-less item is tombstoned.

## 2. The cost, stated plainly

After a purge, timestamp-less deliveries for that source are dropped until the user's explicit
re-sync fires §4.8's `DELETE` — the one verb §6.2 allows to clear a tombstone. Fireflies has
shipped both payload shapes and old workspace configs still send the legacy one, so this is a real
availability cost for such a workspace, not a fossil case.

It is bounded and visible:

- it applies only to an address that has purged and not re-synced;
- each drop is logged `op=drop … reason=purged_no_timestamp` (distinct from `reason=purged`), so
  an operator can tell "this predates the purge" from "this shape carries no stamp";
- the cohort is operator-only.

The alternative reading — accept it — puts back a meeting the user deleted, while they are
offline, which §6.2 calls the exact failure the ledger exists to prevent.

**Open for an operator decision, NOT decided here:** whether to instead deprecate the legacy shape
behind a flag (reject it at the route with a documented error) so the fail-closed drop never has to
fire. That trades a silent post-purge gap for a loud pre-purge one and is a product call.

## 3. `purgedThrough` defaults to *now*, and that is broad

§4.8 specifies `purgedThrough?: string /* ISO; defaults to now */`. The default is fail-closed and
it is **wide**: the watermark tombstones by time, so a purge naming one meeting suppresses every
delivery whose provider stamp predates the request instant — not just the submitted ids. That is
the §6.2 semantics ("protection is unbounded in id count — one timestamp covers a 5,000-meeting
purge") and it is deliberate, but it is invisible from the 204/200 response.

Callers that mean "these ids and no more history" must send `purgedThrough` explicitly, set to the
newest provider stamp among the submitted ids — §6.2's own "max `receivedAt` at purge time"
reading. The route logs `through_source=default_now` vs `through_source=client` so a targeted
purge is distinguishable from a whole-history one after the fact.

**For F3/F4 (frontend):** send `purgedThrough` when the purge is scoped to selected meetings.
Omitting it is correct only for "forget everything up to now".

## 4. A 404 is not permission to skip the tombstone

`webhooksApi` maps every 404 to `feature-dark`, and the teardown used to treat that as "the router
is not mounted, so there is nothing to record" and carry on. A per-route 404 from a **mounted**
router is real — a method or path drift, a reverse proxy, a bundle that outlived a backend route
rename all answer one — and forgiving it made a delete-data disconnect skip `POST /purged` AND
`DELETE /config`, delete the key and the local rows, and report *"Disconnected. Your meetings have
been deleted and background notifications are off."* The ledger was never written and the webhook
stayed live, so the queue kept filling and the next visit re-ingested meetings the user had
deleted: precisely the failure §6.2 exists to prevent, reached through the message that says it
did not happen.

Darkness is therefore ESTABLISHED, once, and carried as state:

- `BackgroundSyncSection`'s mount-time `GET /config` is the probe; its verdict is reported up to
  `ConnectorsCard` and handed to the teardown as `DisconnectDeps.featureDark`;
- `recordPurge` and `disableWebhooks` forgive a 404 only when that flag is set. Otherwise it is a
  hard failure with a retry, and nothing past it runs — an irreversible teardown never accepts a
  404 as "nothing to do";
- `featureDark` defaults to **false**. Unknown is not dark.

Pinned by `connectorLifecycle.test.ts` ("an unexplained 404 on the tombstone deletes nothing and
offers a retry", "…on disable stops the teardown with a retry") and by `ConnectorsCard.test.ts`
("the card carries the mount-time dark verdict into the teardown").

## 5. What the server-side content store tombstones — and what it deliberately does not

Backend ingest (backend-ingest plan §8.1 W4) adds a second tombstone surface, and it covers exactly
two things:

- the **D2a retention sweep** (`ContentStore.sweepRetention`, 90 days) records every swept id as a
  retention tombstone, so a provider replay cannot silently re-store aged-out content;
- the **§6.2 purge ledger** covers teardown/disconnect, as above.

The **per-user overflow caps** (500 meetings / 200 MB, oldest-drop) record **no** tombstone, on
purpose. The two markers above both mean *the user no longer has this*; a cap eviction means only
*this did not fit today*. The cost, stated plainly: because a delivery carrying no provider
timestamp is replayable indefinitely (§1 above), a replay of an evicted meeting re-fetches and
re-stores it, evicting the current oldest row in turn — at the caps, the policy behaves as churn
rather than as a hard bound. It is bounded and visible: every drop is counted
(`stats().droppedOverflow`) and logged `op=overflow-drop reason=user_meeting_cap|user_byte_cap` with
a hashed id.

The alternative — tombstoning evicted ids — would permanently deny a heavy user a meeting they
could otherwise re-sync after pruning, which is why it is not the default. Pinned by
`backend/src/__tests__/connector-content-store.test.ts` (`[delta-08] overflow eviction is
deliberately NON-permanent`).

**Open for an operator decision, NOT decided here:** whether to add an eviction tombstone (a
`reason`-tagged `RetentionTombstone`) once real cohort volumes show the churn loop actually firing.
