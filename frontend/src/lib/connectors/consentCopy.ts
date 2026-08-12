/**
 * Background-sync consent copy — the verbatim §3.8 text for the shipped option.
 *
 * This lives as a constant, not as JSX, for one reason: `backend/src/__tests__/consent-scope.test.ts`
 * (build task B2) asserts every factual claim below against the scope the backend delegation
 * actually activates, so widening the scope without updating this text fails CI, and softening
 * this text without narrowing the scope fails it too. The renderer must not restate, paraphrase,
 * or extend any sentence in it.
 *
 * The variant is chosen by the operator's answers to §10.1 / §10.2, never by a builder. This
 * build ships **Option C** (operator decision 2026-08-04, recorded in
 * `docs/connector-webhooks-delegation-gate.md`): the server receives signed notifications and
 * queues meeting ids only. It never receives the Fireflies API key, never writes meeting content,
 * and holds **no connector delegation** — `backendDelegationPermissions()` stays at v1's
 * non-connector scope. The A and B variants are drafted in §3.8 and are deliberately absent here:
 * whichever is chosen is shipped verbatim and the others are deleted rather than kept around to
 * drift. **Option B's consent checkbox went with Option B** — under C the user grants no
 * permission, so there is no permission to attest to, and a dormant checkbox string would be an
 * invitation to render a consent gate for a grant that does not exist.
 *
 * Inline `**bold**` / `*emphasis*` markers are part of the drafted copy and are preserved so the
 * text stays comparable to §3.8 line by line. The renderer is responsible for them.
 *
 * DO NOT add a sentence claiming a permission cannot reach something ("and nothing else", "not
 * your chats", "only your connectors data"). Dropping the grant does not license that sentence:
 * the node cannot confine a SQL delegation to a path (§0a), the escape is unpatched, and B2's
 * deny-list fails the build on any such sentence until `test/connectors/fixtures/V3_VERDICT.json`
 * records the node fix as live. What C *may* say — and does — is that no permission is granted at
 * all, because that is a fact about our own policy, and B2 checks it against
 * `backendDelegationResolvedPermissions()` on every run.
 *
 * INGEST-CUTOVER(plan §11): this file now carries a SECOND text,
 * `BACKEND_INGEST_CONSENT_COPY`, for the backend-ingest dark cohort. Option C below is unchanged
 * — it is still what a non-cohort user reads, and plan §5.3 requires that path to stay
 * byte-identical. The cohort text is not a softening of C; it is C's two custody sentences
 * replaced by what is actually true once the server holds the credential and the meeting.
 */

export type ConsentCopyVariant = "A" | "B" | "C" | "B-ingest";

export interface BackgroundSyncConsentCopy {
  /** Which §3.8 branch this text is. Read by B2 to pick its assertion set. */
  readonly variant: ConsentCopyVariant;
  readonly heading: string;
  readonly intro: string;
  readonly changesHeading: string;
  readonly bullets: readonly string[];
  /**
   * INGEST-CUTOVER(plan §11): the attestation sentence, present ONLY on the cohort variant.
   * Option C still has none and must keep none — under C nothing is granted and nothing is held,
   * so there is nothing to attest to (see the header note). Under backend ingestion there are two
   * disclosures the user should have to acknowledge in one sentence: the full-account token and
   * the 90-day content copy. Optional on the interface so Option C stays byte-identical.
   */
  readonly consentCheckbox?: string;
  /**
   * INGEST-CUTOVER(plan §11): what disconnect actually does, cohort variant only — including the
   * one part a user would be misled by if it were smoothed. `services/connector-teardown.ts`
   * deletes the credential row unconditionally but carries a FAILED upstream revoke out as a
   * value (`upstreamRevoked: false` + `reason`), so the provider-side grant may still be live.
   * The copy says that rather than promising a revoke we cannot guarantee.
   */
  readonly disconnectNote?: string;
}

export const BACKGROUND_SYNC_CONSENT_COPY: BackgroundSyncConsentCopy = {
  variant: "C",
  heading: "Background sync (optional)",
  intro:
    "Right now, TinyChat has to go looking for new Fireflies meetings every time you open it. " +
    "Turn this on and Fireflies will tell our server the moment a meeting finishes, so TinyChat " +
    "already knows exactly what's new the next time you open it — and pulls those meetings in " +
    "without you clicking Sync.",
  changesHeading: "What this changes",
  bullets: [
    "Our server learns **which meetings are ready** and when: a meeting id and a timestamp, held " +
      "in a short list until your browser collects them. It never receives the meeting itself — " +
      "no title, no transcript, no summary, no attendees.",
    "It **never sees your Fireflies key**. The key stays where it is today, and only your browser " +
      "reads it. Your browser is what asks Fireflies for the meeting and what saves it to your " +
      "space.",
    "Turning this on gives our server **no new permission** on your space. Background sync asks " +
      "you to grant nothing, and nothing is granted — our server has no standing that would let " +
      "it add, change or take away a meeting or a transcript of yours. It never saves a meeting " +
      "for you; your browser does that, every time.",
    "**This is not fully-offline ingestion, and we won't pretend otherwise.** The notification " +
      "arrives while TinyChat is closed; the meeting itself is fetched and saved on **your next " +
      "visit** — the next time you open TinyChat signed in, with your Fireflies key available to " +
      "your browser. Until then the id waits in that list. Ids nobody collects are dropped after " +
      "14 days.",
    "You'll copy a web address and a secret into your Fireflies dashboard. Treat that web address " +
      "**like a password** — anyone holding it can tell our server that one of your meetings is " +
      "ready.",
    "Our server keeps a running operational log so we can tell whether sync is working, and " +
      "**that log is publicly readable**. It records *that* a meeting arrived and when, with your " +
      "address and the meeting id replaced by scrambled stand-ins — never meeting content, your " +
      "key, or your secret.",
    "Turning this off here stops our server accepting notifications immediately, and drops the " +
      "ids it was still holding for you. Signing out stops the browser half.",
  ],
};

/**
 * INGEST-CUTOVER(plan §11) — the COHORT copy, for addresses enrolled in the backend-ingest dark
 * cohort (`CONNECTOR_BACKEND_INGEST_ENABLED` + the per-address allowlist).
 *
 * This is the honest half of a deliberate reversal. Option C above is untouched and stays the
 * shipped text for every non-cohort user, byte for byte. For a cohort user two of Option C's
 * sentences are simply no longer true — the server DOES hold a Fireflies credential and it DOES
 * receive the meeting — so those formulations are absent here rather than softened (plan §11
 * requirement 4). What replaces them is stated plainly:
 *
 *  1. the server holds a Fireflies credential (DECISIONS `V-a-branch: b1` — OAuth, revocable and
 *     expiring), and, because Fireflies publishes no data scopes, what that credential could do
 *     if it were stolen (plan §11 requirement 1; the operator's signed blast-radius acceptance);
 *  2. meeting content is stored server-side, encrypted, for the D2a retention window
 *     (`RETENTION_WINDOW_DAYS = 90`, `backend/src/services/content-store.ts`), and deleted on
 *     disconnect/purge (requirement 2);
 *  3. no confinement claim — the INTERNAL escape (plan §3 item 3 / `V3_VERDICT.json`) is
 *     unpatched, so B2's deny-list applies to this variant exactly as it does to C — and no
 *     promise of capture beyond the meetings the user OWNS (plan §10, requirement 3).
 *
 * The one Option-C sentence that survives verbatim in substance is "no new permission on your
 * space": B mints no connector delegation (plan §9 row 3), custody is out-of-band, and the
 * backend policy stays `threads/`-only. That is a fact about our own policy, checked on every run
 * by `backend/src/__tests__/consent-scope.test.ts`.
 *
 * **The words below ARE the Gate 6 approval artifact.** `docs/connector-webhooks-backend-ingest-
 * consent-copy.md` mirrors them for the operator to approve, and consent-scope.test.ts compares
 * the two sentence for sentence — so the text the operator signs off and the text the product
 * would render cannot decouple again (the divergence the cutover audit found).
 *
 * **RENDERED (residual F011 — CLOSED 2026-08-11, operator-approved unfreeze).** The renderer,
 * `frontend/src/chat/BackgroundSyncSection.tsx`, probes the cohort-gated
 * `GET /api/connectors/meetings` once at mount and selects this variant only on an affirmative
 * cohort answer; every other outcome — the 404 (`feature-dark`), auth, offline, retryable,
 * rejected, a thrown probe, or no meetings client at all — fails closed to Option C, so a
 * non-cohort address can never be shown this text. Under it the enable action stays inert until
 * the attestation checkbox is checked, and the disconnect note renders with it. What remains is
 * the enable-time eyes-on check in operator pre-rollout gate 4 of `docs/deployment.md` (the
 * cohort-enable checklist's smoke step): the enrolled address actually sees this rendered
 * consent before any real credential is seeded. Closure record:
 * `docs/connector-webhooks-p1-residuals.md` §F011.
 */
export const BACKEND_INGEST_CONSENT_COPY: BackgroundSyncConsentCopy = {
  variant: "B-ingest",
  heading: "Background sync (server-side ingestion)",
  intro:
    "With this on, our server does the collecting: Fireflies tells it the moment one of your " +
    "meetings finishes, our server fetches that meeting and holds it for you, and it is already " +
    "there the next time you sign in — on a phone that has never held your Fireflies key and has " +
    "never opened TinyChat before. That convenience is bought with real custody, and the rest of " +
    "this page is what we hold and for how long.",
  changesHeading: "What this changes",
  bullets: [
    "Our server holds a **Fireflies credential of yours** — an OAuth token you authorize, which " +
      "our server keeps encrypted and uses to fetch your finished meetings. Fireflies offers no " +
      "read-only permission: the only scopes it publishes are your name and your email, and " +
      "access to your data rides along with the grant. So the token our server holds reaches your " +
      "Fireflies account the way you do — it can read your meetings, and it can also delete them, " +
      "reshare them, and change who has what role. **If our server is breached, that is what the " +
      "attacker holds**, until the token is revoked or expires. You can revoke it in Fireflies at " +
      "any time, and disconnecting here asks Fireflies to revoke it too — if that upstream revoke " +
      "fails we tell you so instead of pretending it worked, and revoking it yourself in Fireflies " +
      "is what finishes the job.",
    "Our server **fetches the meeting itself and keeps its own copy** — title, transcript, " +
      "summary, attendees — encrypted at rest under a key our server holds, for up to **90 days** from the " +
      "day it arrives. After that the copy is swept, and a later re-delivery of the same meeting " +
      "does not bring it back. Disconnecting, or asking us to purge, deletes the stored meetings " +
      "and the credential straight away.",
    "Fireflies notifies us about the meetings **you own**. A meeting owned by someone else on " +
      "your Fireflies account is not sent to us and does not appear here.",
    "Turning this on gives our server **no new permission on your space**. Background sync asks " +
      "you to grant nothing, and nothing is granted — the credential above is held by our server, " +
      "outside your space, and our server writes no meeting into your space. Your browser still " +
      "does that, when you are signed in with your vault unlocked, so your own copy lands where " +
      "it always did — and it stays yours: it is not deleted when our 90-day window closes. What " +
      "changed is not what our server is *permitted* to do — it is what our server now *has*: " +
      "your Fireflies token, and a copy of your meetings.",
    "**Signing in is still required.** \"Already there\" means you do not have to set the device " +
      "up — nothing to unlock before your meetings appear, no Fireflies key to type. It does not " +
      "mean your meetings are reachable without signing in as you.",
    "You'll copy a web address and a secret into your Fireflies dashboard. Treat that web address " +
      "**like a password** — anyone holding it can tell our server that one of your meetings is " +
      "ready.",
    "Our server keeps a running operational log so we can tell whether sync is working, and " +
      "**that log is publicly readable**. It records *that* a meeting arrived and when, with your " +
      "address and the meeting id replaced by scrambled stand-ins — never meeting content, your " +
      "credential, or your secret.",
    "Turning this off stops our server accepting notifications immediately, deletes the meetings " +
      "our server was holding for you, and asks Fireflies to revoke the credential — see below " +
      "for what happens if Fireflies cannot be reached.",
  ],
  consentCheckbox:
    "I understand that TinyChat's server will hold a full-account Fireflies token for me and a " +
    "copy of my meetings for up to 90 days.",
  disconnectNote:
    "**Disconnecting undoes all of it, in one click.** We revoke the Fireflies token upstream and " +
    "delete it, delete every meeting we are holding for you, and stop accepting notifications. " +
    "If Fireflies is down and we cannot revoke upstream, we tell you so instead of pretending it " +
    "worked — so you can revoke it yourself from your Fireflies account.",
};

/**
 * Every sentence of the shipped copy as one string — what B2's claim patterns are matched against.
 *
 * INGEST-CUTOVER(plan §11): the optional attestation and disconnect sentences are folded in when
 * present, so the confinement / delete-capability deny-lists scan them too. A sentence that only
 * appears in the checkbox is still a sentence we show the user.
 */
export function consentCopyText(copy: BackgroundSyncConsentCopy): string {
  return [
    copy.heading,
    copy.intro,
    copy.changesHeading,
    ...copy.bullets,
    ...(copy.consentCheckbox === undefined ? [] : [copy.consentCheckbox]),
    ...(copy.disconnectNote === undefined ? [] : [copy.disconnectNote]),
  ].join("\n");
}
