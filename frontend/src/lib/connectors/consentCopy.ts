/** Shared heading-and-paragraph copy for connector consent surfaces. */

import type { TranscriptConsentState } from "../transcriptDeliveryState";

export type ConsentCopyVariant =
  | "A" | "B" | "C" | "B-ingest" | "google-oauth" | "google-calendar-autojoin"
  | "C-transcript-writer" | "B-ingest-transcript-writer"
  | "google-oauth-transcript-writer" | "google-calendar-autojoin-transcript-writer";

export interface BackgroundSyncConsentCopy {
  /** Identifies the copy variant for renderers. */
  readonly variant: ConsentCopyVariant;
  readonly heading: string;
  readonly intro: string;
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
  heading: "Background sync",
  intro:
    "Fireflies tells our server when a meeting finishes, and TinyCloud One pulls it into your space the next time you open it. Our server gets only the meeting's ID, never its content or your Fireflies key.",
};


/** Consent copy for Fireflies users in the server-side ingest cohort. */
export const BACKEND_INGEST_CONSENT_COPY: BackgroundSyncConsentCopy = {
  variant: "B-ingest",
  heading: "Background sync (server-side)",
  intro:
    "Our server keeps your Fireflies sign-in and a copy of each finished meeting for up to 90 days, so your meetings are waiting on any device you sign in on. Fireflies can't limit that sign-in, so it gives full access to your Fireflies account. Disconnecting deletes both and asks Fireflies to revoke it.",
  disconnectNote:
    "**Disconnecting undoes all of it, in one click.** We revoke the Fireflies token upstream and " +
    "delete it, delete every meeting we are holding for you, and stop accepting notifications. " +
    "If Fireflies is down and we cannot revoke upstream, we tell you so instead of pretending it " +
    "worked — so you can revoke it yourself from your Fireflies account.",
};

/** Google Meet OAuth authorization copy. */
export const GOOGLE_MEET_CONSENT_COPY: BackgroundSyncConsentCopy = {
  variant: "google-oauth",
  heading: "Connect Google Meet",
  intro:
    "You'll sign in with Google so TinyCloud One can read your Meet transcripts and Gemini notes and turn on transcription for meetings you host. Your browser fetches them from Google and saves them to your space; our server never keeps your Google token or your meetings.",
  disconnectNote:
    "**Disconnecting asks Google to revoke this access and deletes the saved token from your " +
    "secrets.** If Google cannot be reached we say so instead of pretending the revoke worked, " +
    "and you can always remove TinyChat yourself from your Google account's third-party access " +
    "page. Your already-synced meetings stay in your space unless you also choose to delete them.",
};

export const GOOGLE_TESTING_MODE_REAUTH_COPY =
  "While TinyChat's Google app is in testing, Google asks you to reconnect about once a week.";




/** Separate custody consent: ordinary browser import remains stateless on the server. */
export const GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY: BackgroundSyncConsentCopy = {
  variant: "google-calendar-autojoin",
  heading: "Calendar autojoin",
  intro:
    "TinyCloud One sends a notetaker to Google Meet events on your main calendar that you organize or have accepted, even while TinyCloud One is closed; the host still admits it. To do that, our server keeps your Google sign-in and reads your calendar. Turning this off deletes it.",
  disconnectNote: "Disconnecting Google Meet also stops Calendar autojoin, removes the server’s token and asks Google to revoke it. A failed revoke is reported. Your recordings remain available.",
};

/**
 * The transcript-writer grant, as it really is. Its SQL half is read+write on the whole connectors
 * database: the `connector_meeting` rows of every connector, local recordings and voice notes
 * included, and at the node `write` includes UPDATE and DELETE. Its KV half reads and saves the
 * Notetaker's transcript bodies. It says what the grant covers and claims no limit on what it can
 * reach (V3), and claims nothing about other connectors' transcript bodies, which it does not ask for.
 */
const TRANSCRIPT_WRITER_NOTICE =
  "Because the Private Notetaker is on, our server can also read, change and delete the meeting records in your connectors library, and save Notetaker transcripts there.";

export const BACKGROUND_SYNC_TRANSCRIPT_CONSENT_COPY: BackgroundSyncConsentCopy = {
  ...BACKGROUND_SYNC_CONSENT_COPY,
  variant: "C-transcript-writer",
  intro: `${BACKGROUND_SYNC_CONSENT_COPY.intro} ${TRANSCRIPT_WRITER_NOTICE}`,
};

export const BACKEND_INGEST_TRANSCRIPT_CONSENT_COPY: BackgroundSyncConsentCopy = {
  ...BACKEND_INGEST_CONSENT_COPY,
  variant: "B-ingest-transcript-writer",
  intro: `${BACKEND_INGEST_CONSENT_COPY.intro} ${TRANSCRIPT_WRITER_NOTICE}`,
};

export const GOOGLE_MEET_TRANSCRIPT_CONSENT_COPY: BackgroundSyncConsentCopy = {
  ...GOOGLE_MEET_CONSENT_COPY,
  variant: "google-oauth-transcript-writer",
  intro: `${GOOGLE_MEET_CONSENT_COPY.intro} ${TRANSCRIPT_WRITER_NOTICE}`,
};

export const GOOGLE_CALENDAR_AUTOJOIN_TRANSCRIPT_CONSENT_COPY: BackgroundSyncConsentCopy = {
  ...GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY,
  variant: "google-calendar-autojoin-transcript-writer",
  intro: `${GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY.intro} ${TRANSCRIPT_WRITER_NOTICE}`,
};

export function transcriptAwareConsentCopy(
  copy: BackgroundSyncConsentCopy,
  state: TranscriptConsentState,
): BackgroundSyncConsentCopy {
  if (state === "inactive") return copy;
  switch (copy.variant) {
    case "C": return BACKGROUND_SYNC_TRANSCRIPT_CONSENT_COPY;
    case "B-ingest": return BACKEND_INGEST_TRANSCRIPT_CONSENT_COPY;
    case "google-oauth": return GOOGLE_MEET_TRANSCRIPT_CONSENT_COPY;
    case "google-calendar-autojoin": return GOOGLE_CALENDAR_AUTOJOIN_TRANSCRIPT_CONSENT_COPY;
    default: return copy;
  }
}
