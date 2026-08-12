# Backend-ingest consent copy — the Gate 6 approval text

**Traceability marker:** `INGEST-CUTOVER(plan §11)`. This file is the operator-facing mirror of
`BACKEND_INGEST_CONSENT_COPY` (`frontend/src/lib/connectors/consentCopy.ts`). It exists because the
cutover audit found the approval artifact and the shipped constant had drifted apart — different
variant, different bullet count, an attestation checkbox that existed only on paper. So the words
now live in exactly two places and `backend/src/__tests__/consent-scope.test.ts` compares them
sentence for sentence: **editing one without the other fails the build.** The operator therefore
approves the text the product would actually render, not a draft of it.

**Status: APPROVED — 2026-08-11, operator-authorized ("go with the recommended option"), recorded
by roman-delegated-claude; includes the "attendees" disclosure amendment in bullet 2 (the fetch
includes `meeting_attendees { displayName email }`, so the stored copy does too).** Nothing here
ships and no flag flips on the strength of this file. The design rationale — which §11 requirement each paragraph discharges, the inputs it
was written from, and the sentences deliberately *not* written — stays in
`docs/specs/tinychat-webhooks-backend-ingest-consent-copy.md` in the specs repo; this file carries
only the words.

**It is not rendered yet.** The single consent renderer
(`frontend/src/chat/BackgroundSyncSection.tsx`) is on the frozen drain-UX increment and shows
Option C unconditionally, so a cohort address would today read Option C's retired custody
sentences. That is residual **F011** (`docs/connector-webhooks-p1-residuals.md`) and operator
pre-rollout gate **4** (`docs/deployment.md`), and it blocks enabling
`CONNECTOR_BACKEND_INGEST_ENABLED` for any address.

**Scope.** Cohort addresses only. The shipped Option C text (`variant: "C"`) stays byte-identical
for everyone else (plan §5.3), and its key-custody / content-custody sentences remain factually
true *for them*.

**Inputs (read, not invented):** credential kind = unscoped OAuth token, branch `b1`
(DECISIONS `V-a-branch`); blast radius = read **and** delete / re-share / re-role, until revoked or
expired (`Blast-radius-acceptance: signed`); retention = **90 days** (`D2a-retention-days`);
reconcile = `retain`; cohort = operator-only dark cohort (`D5-cohort`).

---

## variant

> B-ingest

## heading

> Background sync (server-side ingestion)

## intro

> With this on, our server does the collecting: Fireflies tells it the moment one of your meetings
> finishes, our server fetches that meeting and holds it for you, and it is already there the next
> time you sign in — on a phone that has never held your Fireflies key and has never opened
> TinyChat before. That convenience is bought with real custody, and the rest of this page is what
> we hold and for how long.

## changesHeading

> What this changes

## bullet 1

> Our server holds a **Fireflies credential of yours** — an OAuth token you authorize, which our
> server keeps encrypted and uses to fetch your finished meetings. Fireflies offers no read-only
> permission: the only scopes it publishes are your name and your email, and access to your data
> rides along with the grant. So the token our server holds reaches your Fireflies account the way
> you do — it can read your meetings, and it can also delete them, reshare them, and change who has
> what role. **If our server is breached, that is what the attacker holds**, until the token is
> revoked or expires. You can revoke it in Fireflies at any time, and disconnecting here asks
> Fireflies to revoke it too — if that upstream revoke fails we tell you so instead of pretending
> it worked, and revoking it yourself in Fireflies is what finishes the job.

## bullet 2

> Our server **fetches the meeting itself and keeps its own copy** — title, transcript, summary, attendees —
> encrypted at rest under a key our server holds, for up to **90 days** from the day it arrives.
> After that the copy is swept, and a later re-delivery of the same meeting does not bring it back.
> Disconnecting, or asking us to purge, deletes the stored meetings and the credential straight
> away.

## bullet 3

> Fireflies notifies us about the meetings **you own**. A meeting owned by someone else on your
> Fireflies account is not sent to us and does not appear here.

## bullet 4

> Turning this on gives our server **no new permission on your space**. Background sync asks you to
> grant nothing, and nothing is granted — the credential above is held by our server, outside your
> space, and our server writes no meeting into your space. Your browser still does that, when you
> are signed in with your vault unlocked, so your own copy lands where it always did — and it stays
> yours: it is not deleted when our 90-day window closes. What changed is not what our server is
> *permitted* to do — it is what our server now *has*: your Fireflies token, and a copy of your
> meetings.

## bullet 5

> **Signing in is still required.** "Already there" means you do not have to set the device up —
> nothing to unlock before your meetings appear, no Fireflies key to type. It does not mean your
> meetings are reachable without signing in as you.

## bullet 6

> You'll copy a web address and a secret into your Fireflies dashboard. Treat that web address
> **like a password** — anyone holding it can tell our server that one of your meetings is ready.

## bullet 7

> Our server keeps a running operational log so we can tell whether sync is working, and **that log
> is publicly readable**. It records *that* a meeting arrived and when, with your address and the
> meeting id replaced by scrambled stand-ins — never meeting content, your credential, or your
> secret.

## bullet 8

> Turning this off stops our server accepting notifications immediately, deletes the meetings our
> server was holding for you, and asks Fireflies to revoke the credential — see below for what
> happens if Fireflies cannot be reached.

## consentCheckbox

> I understand that TinyChat's server will hold a full-account Fireflies token for me and a copy of
> my meetings for up to 90 days.

## disconnectNote

> **Disconnecting undoes all of it, in one click.** We revoke the Fireflies token upstream and
> delete it, delete every meeting we are holding for you, and stop accepting notifications. If
> Fireflies is down and we cannot revoke upstream, we tell you so instead of pretending it worked —
> so you can revoke it yourself from your Fireflies account.
