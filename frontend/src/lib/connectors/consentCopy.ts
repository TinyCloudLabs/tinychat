/**
 * Background-sync consent copy — the shipped variants, centralized for renderers.
 * Do not restate or extend these sentences in JSX. Inactive transcript delivery
 * preserves the original copy; an active grant selects the separate disclosure.
 *
 * The operator chose **Option C** for Fireflies (recorded in
 * `docs/connector-webhooks-delegation-gate.md`): its webhook queues meeting ids
 * without minting a Fireflies connector delegation. TC-641 is a separate,
 * default-off transcript-writer grant; this comment does not describe that policy.
 * Option B's consent checkbox went with Option B and is absent here.
 *
 * Inline `**bold**` / `*emphasis*` markers are part of the drafted copy and are preserved so the
 * text stays comparable to §3.8 line by line. The renderer is responsible for them.
 *
 * DO NOT add a sentence claiming a permission cannot reach something ("and nothing else", "not
 * your chats", "only your connectors data"). The node cannot confine a SQL delegation to a
 * path (§0a); `test/connectors/fixtures/V3_VERDICT.json` still records the escape.
 * Option C's "no new permission" wording refers to Fireflies webhook ingestion,
 * not to the backend's whole policy. TC-641's independent transcript-writer
 * grant is disclosed when its status is active or cannot be determined.
 *
 * GMEET(connector plan §4.1/§4.3, WP-C): `GOOGLE_MEET_CONSENT_COPY` is for the
 * Google Meet OAuth connect dialog, not the Fireflies background-sync path.
 * It renders through the same interface, so the text lives here instead of JSX.
 */

import type { TranscriptConsentState } from "../transcriptDeliveryState";

export type ConsentCopyVariant =
  | "A" | "B" | "C" | "google-oauth" | "google-calendar-autojoin"
  | "C-transcript-writer"
  | "google-oauth-transcript-writer" | "google-calendar-autojoin-transcript-writer";

export interface BackgroundSyncConsentCopy {
  /** Identifies the copy variant for renderers. */
  readonly variant: ConsentCopyVariant;
  readonly heading: string;
  readonly intro: string;
  readonly changesHeading: string;
  readonly bullets: readonly string[];
  /**
   * The attestation sentence, present only for a copy whose enable action needs the
   * user's explicit acknowledgement of server-side custody (Calendar autojoin). Option C
   * has no Fireflies grant or server-held Fireflies credential.
   */
  readonly consentCheckbox?: string;
  /** What disconnect actually does, for a copy that describes custody the server holds. */
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
 * GMEET(connector plan §4.1, §4.3, §6 WP-C) — the Google Meet CONNECT consent text.
 *
 * A different lane from Option C above and it says so in its own words: nothing about background
 * notifications, no queue, no delivery URL. What it has to be honest about is the trust model the
 * plan settled on, which is unusual in exactly one place — the backend is a stateless
 * code-exchange/refresh proxy, so Google token material passes THROUGH it (Google requires the
 * app's client secret on the token call) while nothing is stored there. Saying "the server never
 * touches your token" would be false; saying nothing about it would be the same omission by
 * silence. So the transient visibility is stated, with the bound that makes it acceptable.
 *
 * The other four things it must carry, per the plan:
 *
 *  1. Google and OAuth NAMED, and every requested scope described in plain language.
 *  2. The browser fetches meeting content DIRECTLY from Google; it does not pass through the
 *     TinyChat backend, and the data lands only in the user's space.
 *  3. The coverage cliff, D5's tone: cause named, no dead ends. A Google transcript exists only
 *     when the HOST was on a paid Workspace edition AND transcription was on for that meeting.
 *     The sentence names what closes the gap instead of leaving the user at a wall.
 *  4. No confinement claim: `V3_VERDICT.json` records the SQL escape unpatched.
 *     Google Meet OAuth mints no Google-specific backend delegation; this is
 *     distinct from TC-641's separate transcript-writer policy.
 *
 * No `consentCheckbox`: Google OAuth mints no Google-specific backend delegation,
 * so there is nothing to attest to here. The `disconnectNote` IS present, because disconnect has
 * a real failure mode worth naming up front (an upstream revoke Google may refuse).
 */
export const GOOGLE_MEET_CONSENT_COPY: BackgroundSyncConsentCopy = {
  variant: "google-oauth",
  heading: "Connecting Google Meet",
  intro:
    "You'll sign in with Google in a popup window and approve Google Meet, Drive metadata, and " +
    "Google Docs read permissions (a standard Google OAuth consent screen). After that, this " +
    "browser fetches your Meet transcripts and relevant Notes by Gemini from Google and writes " +
    "them into your space.",
  changesHeading: "What you're granting",
  bullets: [
    "*See your Google Meet meetings, their transcripts and who took part* — the conference " +
      "records your Google account already has access to. *Change Google Meet transcription " +
      "settings* — so TinyChat can offer to switch automatic transcription on for **meetings you " +
      "host**. *See Drive file metadata and read matching Google Docs* — so TinyChat can find " +
      "and import Notes by Gemini meeting records. No Calendar or Gmail permission is requested.",
    "**Your browser talks to Google directly.** Titles, transcripts and participants are fetched " +
      "by this browser from Google's API and written straight into your space — that content " +
      "**never passes through TinyChat's server**, and we keep no copy of it.",
    "**Our server sees Google tokens only in passing.** Google requires the app's client secret " +
      "to trade your sign-in for a token, so that one call — and each later token refresh — goes " +
      "through our backend, inside the attested CVM. It **persists nothing**: no database row, no " +
      "file, and no log line carrying a token. The long-lived token comes straight back to your " +
      "browser and is saved in your TinyCloud encrypted secrets, the same place your other " +
      "connector credentials live.",
    "Connecting gives our server **no new permission** on your space. Nothing is granted and " +
      "nothing is asked for — the synced meetings are written by your browser, as they are today.",
    "**A Google transcript only exists when two things were true of the meeting**: the host was " +
      "on a paid Google Workspace edition (Business Standard/Plus, Enterprise, Education, or " +
      "Workspace Individual) **and** transcription was switched on for that meeting. Meetings " +
      "hosted on a free/consumer Google account never produce one — for any tool, this connector " +
      "included. That is Google's limit rather than ours, and switching on auto-transcription for " +
      "**meetings you host** is what closes most of the gap. Notes by Gemini can also appear when " +
      "Google creates a matching meeting Doc.",
    "**Google keeps meeting records for about 30 days.** The first sync reaches back a month at " +
      "most, and meetings older than that are gone from Google's side before we ever ask — so " +
      "connecting sooner is what widens the history, never a later backfill.",
  ],
  disconnectNote:
    "**Disconnecting asks Google to revoke this access and deletes the saved token from your " +
    "secrets.** If Google cannot be reached we say so instead of pretending the revoke worked, " +
    "and you can always remove TinyChat yourself from your Google account's third-party access " +
    "page. Your already-synced meetings stay in your space unless you also choose to delete them.",
};

/**
 * TC-522: the Exo app signs in with Google through the system browser (TC-521), never in a popup
 * window. Only that phrase changes; every claim is the pinned text, word for word.
 */
export function googleConsentCopyForSystemBrowser(copy: BackgroundSyncConsentCopy): BackgroundSyncConsentCopy {
  return { ...copy, intro: copy.intro.replace("in a popup window", "in your browser") };
}

/**
 * GMEET(plan §2b gate G3) — the testing-mode re-auth caveat.
 *
 * Kept OUT of the bullets above deliberately: it is true only while the Google app is in Google's
 * testing mode, and the connect dialog gates it on a flag that ships hidden for the internal-mode
 * dogfood. It lives here anyway, and now rather than later, because G3 requires the caveat to be
 * live in the dialog BEFORE the app opens beyond the team — a string that has to be written under
 * gate pressure is a string that gets written badly.
 */
export const GOOGLE_TESTING_MODE_REAUTH_COPY =
  "While TinyChat's Google app is in Google's testing mode, Google expires the saved access after " +
  "7 days, so you'll be asked to reconnect Google Meet about once a week. Syncing pauses until " +
  "you do — meetings already in your space are unaffected, and nothing is lost as long as you " +
  "reconnect within Google's 30-day record window.";

/**
 * Concatenate the rendered copy fields, including optional checkbox and
 * disconnect text.
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

/** Separate custody consent: ordinary browser import remains stateless on the server. */
export const GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY: BackgroundSyncConsentCopy = {
  variant: "google-calendar-autojoin",
  heading: "Enable Calendar autojoin",
  intro: "TinyChat can send a notetaker to eligible Google Meet events while your browser is closed.",
  changesHeading: "What you authorize",
  bullets: [
    "TinyChat reads events on your primary Google calendar in the background. The Calendar permission can read events on calendars you own; primary-calendar-only is TinyChat’s policy. Confirmed timed Meet events qualify when you organize them or have accepted. Declined, tentative, unanswered and all-day events are skipped.",
    "Our server stores your Google refresh token encrypted and uses it without your browser. The token lets TinyChat read your Google Calendar events and see your Google account identifier and email address. The email is used to match you against event invitations.",
    "The bot may be sent from one minute before start until the earlier of five minutes after start or the event end. It requests admission; the host decides whether to admit it. Meeting title, scheduled start and recording remain available for your return.",
    "Your browser saves completed recordings into your own space after you return and unlock it. Enabling grants the server no new permission to write to your space.",
    "Turning off stops new sends, requests stops for active autojoined bots and deletes the server’s token. Turning off does not revoke Google’s grant; it remains until you disconnect Google Meet or remove TinyChat in your Google account. Turning on again requires this consent again. Connecting a different Google account in the Google Meet importer turns autojoin off until you explicitly re-enable it.",
  ],
  consentCheckbox: "I authorize unattended Calendar reading and encrypted server storage of my Google refresh token to autojoin eligible meetings.",
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
  "Separately, because the TinyCloud Private Notetaker is on, our server holds a permission on " +
  "your space over the **meeting records in your connectors library**: the titles, participants, " +
  "summaries and other details stored for every connector's meetings, Fireflies and Google " +
  "included, and for your local recordings and voice notes. Our server can **read, add, change or " +
  "delete those records**. It can also read and save Notetaker transcripts there. Each grant lasts " +
  "up to 29 days, and your browser renews it without asking while you are signed in and enrolled " +
  "in server delivery.";

/** Replace the listed bullets; every other bullet keeps its original bytes. */
function withBullets(copy: BackgroundSyncConsentCopy, replaced: Record<number, string>): readonly string[] {
  return copy.bullets.map((bullet, index) => replaced[index] ?? bullet);
}

export const BACKGROUND_SYNC_TRANSCRIPT_CONSENT_COPY: BackgroundSyncConsentCopy = {
  ...BACKGROUND_SYNC_CONSENT_COPY,
  variant: "C-transcript-writer",
  bullets: withBullets(BACKGROUND_SYNC_CONSENT_COPY, {
    0: "Our server learns **which meetings are ready** and when: a meeting id and a timestamp, held " +
      "in a short list until your browser collects them. The notification itself carries no title, " +
      "no transcript, no summary and no attendees — but once your browser has saved a meeting, the " +
      "Notetaker permission described below lets our server read its meeting record there.",
    2: "Turning background sync on adds **no new permission** of its own, and asks you to grant " +
      `nothing. ${TRANSCRIPT_WRITER_NOTICE} Your browser still saves Fireflies meetings into your ` +
      "space.",
  }),
};

export const GOOGLE_MEET_TRANSCRIPT_CONSENT_COPY: BackgroundSyncConsentCopy = {
  ...GOOGLE_MEET_CONSENT_COPY,
  variant: "google-oauth-transcript-writer",
  bullets: withBullets(GOOGLE_MEET_CONSENT_COPY, {
    1: "**Your browser talks to Google directly.** Titles, transcripts and participants are fetched " +
      "by this browser from Google's API and written straight into your space — the fetch from " +
      "Google does not go through TinyChat's server, and we keep no copy of it. Once a meeting is in " +
      "your space, the Notetaker permission described below lets our server read, change or delete " +
      "its meeting record there.",
    3: "Connecting adds **no new permission** on your space of its own. This Google connection asks " +
      "you to grant nothing on your space — the synced Google meetings are written by your " +
      `browser, as they are today. ${TRANSCRIPT_WRITER_NOTICE}`,
  }),
  disconnectNote:
    "**Disconnecting asks Google to revoke this access and deletes the saved token from your " +
    "secrets.** If Google cannot be reached we say so instead of pretending the revoke worked, " +
    "and you can always remove TinyChat yourself from your Google account's third-party access " +
    "page. Disconnecting does not delete your already-synced meetings from your space.",
};

export const GOOGLE_CALENDAR_AUTOJOIN_TRANSCRIPT_CONSENT_COPY: BackgroundSyncConsentCopy = {
  ...GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY,
  variant: "google-calendar-autojoin-transcript-writer",
  bullets: withBullets(GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY, {
    3: "Enabling autojoin adds no new permission to write to your space of its own. " +
      `${TRANSCRIPT_WRITER_NOTICE} So an autojoined meeting's transcript may be saved by our ` +
      "server before you return; your browser also saves completed recordings into your own " +
      "space after you return and unlock it.",
  }),
};

/** Unknown status uses the disclosure; inactive preserves every original byte. */
export function transcriptAwareConsentCopy(
  copy: BackgroundSyncConsentCopy,
  state: TranscriptConsentState,
): BackgroundSyncConsentCopy {
  if (state === "inactive") return copy;
  switch (copy.variant) {
    case "C": return BACKGROUND_SYNC_TRANSCRIPT_CONSENT_COPY;
    case "google-oauth": return GOOGLE_MEET_TRANSCRIPT_CONSENT_COPY;
    case "google-calendar-autojoin": return GOOGLE_CALENDAR_AUTOJOIN_TRANSCRIPT_CONSENT_COPY;
    default: return copy;
  }
}
