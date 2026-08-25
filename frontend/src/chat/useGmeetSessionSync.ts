// The once-per-session Google Meet sync trigger (plan §4.2 / §6 WP-B).
//
// G1 ruled that session-start sync suffices for Phase 1: there is no push lane
// and there is NO POLLING here — the triggers are an authenticated app-shell
// mount and a user-initiated vault unlock, nothing else.
//
// A SEPARATE LANE from `useBackgroundDrain`, deliberately. The drainer serves
// the Option-C webhook queue, which google-meet does not have
// (`supportsBackgroundNotifications` returns false for it and stays that way);
// folding this in would tie a browser-direct Google sync to a queue lane it
// shares nothing with. Nothing in this module imports the drainer.
//
// The rules, restated in code:
//
//  - DARK IS A NO-OP. The registry row's `status` is the availability gate and
//    it is read FIRST: while google-meet is `coming-soon` (the whole dark
//    phase) this module reads no SQL, touches no vault, and mints no token —
//    for every user, on every visit.
//  - LOCKED DEFERS, SILENTLY. A locked vault is not an error and not a prompt:
//    the run returns without burning the session's one attempt, so the next
//    unlock (or a manual "Sync now") picks it up.
//  - ONE ATTEMPT PER SESSION. The latch is burned only when a REAL attempt
//    begins — signed out, dark, not connected and locked are all free. Two
//    triggers arriving together JOIN one run (the module's own in-flight slot),
//    because the gates in between are awaits and a latch alone cannot bridge
//    them.
//  - NOTHING ESCAPES. No throw reaches App, no rejection goes unhandled, and
//    nothing renders. Failures leave a debug breadcrumb carrying a fixed
//    string or an error KIND — never a token, a transcript, a meeting title,
//    or Google's message body.
//  - ABORT ON UNMOUNT. One AbortController per mount threads through the token
//    mint, the client and the sync engine; the effect's cleanup aborts it.
//
// The single-flight guard is `syncGoogleMeet`'s own module-level slot, shared
// with the manual "Sync now" button: a concurrent caller JOINS the run in
// flight rather than racing it over the same upserts.

import { useEffect } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS } from "@/lib/connectors/registry";
import {
  countMeetings,
  getDriveCursor,
  putDriveCursor,
  findGmeetNotesAssociation,
  attachGmeetNotes,
  removeGmeetNotes,
  getConnection as storeGetConnection,
  putTranscriptBody,
  updateSyncState,
  upsertMeeting,
  type StoreResult,
} from "@/lib/connectors/connectorStore";
import {
  getConnectorKey,
  isSecretsUnlocked,
  onSecretsUnlocked,
  type SecretsErr,
  type SecretsResult,
} from "@/lib/connectors/connectorSecrets";
import { GmeetClient } from "@/lib/connectors/gmeetClient";
import {
  syncGoogleMeet,
  type GmeetSyncClient,
  type GmeetSyncOptions,
  type GmeetSyncResult,
  type GmeetSyncStore,
} from "@/lib/connectors/gmeetSync";
import type {
  ConnectorConnection,
  ConnectorDescriptor,
  ConnectorId,
} from "@/lib/connectors/types";

/** The registry row this lane belongs to. */
export const GMEET_CONNECTOR_ID: ConnectorId = "google-meet";

/** The authenticated backend proxy that mints an access token (WP-A). */
export const GOOGLE_OAUTH_REFRESH_PATH = "/api/connectors/google/oauth/refresh";

const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

/**
 * Why a run ended. Returned (never thrown) so tests — and a future surface —
 * can tell "deferred" from "failed" without a message to parse. Every value is
 * a fixed string: none of them can carry user data.
 */
export type GmeetSessionSyncOutcome =
  | "signed-out"
  | "already-ran"
  /** The registry row is not `available` — the dark phase, and the default. */
  | "unavailable"
  | "not-connected"
  /** Deferred: the vault is locked. Retriable — the latch was not burned. */
  | "vault-locked"
  | "no-refresh-token"
  | "token-unavailable"
  | "aborted"
  | "synced"
  | "sync-error";

/** Test seams, following `BackgroundDrainHooks`' optional-deps idiom.
 *  Production callers pass none of these — the defaults are the real modules. */
export interface GmeetSessionSyncHooks {
  connectors?: readonly ConnectorDescriptor[];
  getConnection?: (
    tcw: TinyCloudWeb,
    id: ConnectorId,
  ) => Promise<StoreResult<ConnectorConnection | null>>;
  isUnlocked?: (tcw: TinyCloudWeb) => boolean;
  readRefreshToken?: (
    tcw: TinyCloudWeb,
    descriptor: ConnectorDescriptor,
  ) => Promise<SecretsResult<string, SecretsErr>>;
  /** Resolves an access token, or null when one cannot be minted. */
  mintAccessToken?: (refreshToken: string, signal?: AbortSignal) => Promise<string | null>;
  createClient?: (
    accessToken: string,
    refreshAccessToken: () => Promise<string | null>,
    signal?: AbortSignal,
  ) => GmeetSyncClient;
  runSync?: (opts: GmeetSyncOptions) => Promise<GmeetSyncResult>;
  store?: GmeetSyncStore;
  fetchImpl?: typeof fetch;
}

export interface GmeetSessionSyncOptions {
  /** Null while signed out — a free no-op that does NOT consume the attempt. */
  tcw: TinyCloudWeb | null;
  sessionStore: SessionStore;
  backendUrl: string;
  /** The mount's controller signal; aborted by the effect's cleanup. */
  signal?: AbortSignal;
  hooks?: GmeetSessionSyncHooks;
}

/** The real store, assembled explicitly so a signature drift in connectorStore
 *  fails at compile time rather than at the first sync. */
const DEFAULT_STORE: GmeetSyncStore = {
  getConnection: storeGetConnection,
  putTranscriptBody,
  upsertMeeting,
  updateSyncState,
  countMeetings,
  getDriveCursor,
  putDriveCursor,
  findGmeetNotesAssociation,
  attachGmeetNotes,
  removeGmeetNotes,
};

/**
 * Debug-level breadcrumb. Callers pass a FIXED string or an error KIND —
 * never a token, a Google message body, a meeting title or transcript text.
 */
function breadcrumb(what: string): void {
  console.debug(`[gmeet-session-sync] ${what}`);
}

// ── Session state (module-level by design) ───────────────────────────
//
// One browser session = one module instance, which is exactly the lifetime the
// product decision names. A sign-out/sign-in inside one page load does not
// re-arm it — fewer syncs is the safe direction, and "Sync now" is always there.

let attempted = false;

/**
 * The run in flight, if any.
 *
 * The `attempted` latch cannot be burned synchronously — whether an attempt is
 * even warranted takes an awaited SQL read — so a mount and an unlock firing in
 * the same tick would both walk past it. A second caller JOINS the first run
 * and observes its outcome instead of starting a parallel one. (The engine's
 * own single-flight would keep the STORAGE safe either way; this keeps the
 * token mint and the secret read single too.)
 */
let inFlight: Promise<GmeetSessionSyncOutcome> | null = null;

/** True once a real attempt has been made this page load. */
export function hasGmeetSessionSyncRun(): boolean {
  return attempted;
}

/** Tests only, mirroring `resetBackgroundDrainForTests`. */
export function resetGmeetSessionSyncForTests(): void {
  attempted = false;
  inFlight = null;
}

/**
 * Mint a Google access token through the authenticated backend proxy.
 *
 * Nothing is persisted or logged here: the refresh token rides one request
 * body, the access token is returned to the caller and lives in memory for
 * this run only. Every failure — signed out, dark route (404), `invalid_grant`
 * (400/401), a 5xx, a transport error, malformed JSON — resolves to null. The
 * session is deliberately NOT cleared on a 401: this is a background lane, and
 * the app shell owns auth state.
 */
export async function mintGmeetAccessToken(opts: {
  backendUrl: string;
  sessionStore: SessionStore;
  refreshToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const { backendUrl, sessionStore, refreshToken, signal } = opts;
  const bearer = sessionStore.getToken();
  if (!bearer || sessionStore.isExpired()) return null;
  // `fetch` MUST stay bound to the global (see gmeetClient.ts's note).
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);

  let response: Response;
  try {
    response = await fetchImpl(`${backendUrl}${GOOGLE_OAUTH_REFRESH_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
      },
      body: JSON.stringify({ refreshToken }),
      signal,
    });
  } catch {
    // Not narrated: a transport error can echo the request, and no credential
    // material reaches a log from this module.
    return null;
  }

  if (!response.ok) return null;

  let payload: { access_token?: unknown } | null;
  try {
    payload = (await response.json()) as { access_token?: unknown };
  } catch {
    return null;
  }
  const accessToken = payload?.access_token;
  return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : null;
}

function defaultCreateClient(
  accessToken: string,
  refreshAccessToken: () => Promise<string | null>,
  signal?: AbortSignal,
): GmeetSyncClient {
  return new GmeetClient({ accessToken, refreshAccessToken, signal });
}

/**
 * Run the session's Google Meet sync, if this session has not had one.
 *
 * Safe to call from every app-shell render and from every unlock event: the
 * gates below are cheap and ordered cheapest-first, the latch is consumed only
 * by a real attempt, and the returned promise NEVER rejects.
 */
export function maybeStartGmeetSessionSync(
  options: GmeetSessionSyncOptions,
): Promise<GmeetSessionSyncOutcome> {
  if (inFlight) return inFlight;
  const run = guardedRun(options).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function guardedRun(
  options: GmeetSessionSyncOptions,
): Promise<GmeetSessionSyncOutcome> {
  try {
    return await runGmeetSessionSync(options);
  } catch {
    // Defence in depth: every seam is Result-shaped, so nothing here is
    // expected to throw — and if one does, App must not hear about it.
    breadcrumb("session sync stopped on an unexpected failure");
    return "sync-error";
  }
}

async function runGmeetSessionSync(
  options: GmeetSessionSyncOptions,
): Promise<GmeetSessionSyncOutcome> {
  const { tcw, sessionStore, backendUrl, signal } = options;
  if (!tcw) return "signed-out";
  if (attempted) return "already-ran";

  const hooks = options.hooks ?? {};
  const connectors = hooks.connectors ?? CONNECTORS;
  const descriptor = connectors.find((c) => c.id === GMEET_CONNECTOR_ID);

  // DARK-SAFETY, first and cheapest. While the row is `coming-soon` this is the
  // whole function: no SQL read, no vault touch, no request, no latch burned.
  if (!descriptor || descriptor.status !== "available") return "unavailable";

  // The card's own SQL read — it never touches the vault. Unreadable (a session
  // predating the connector permissions, or a space without the db) reads as
  // "not connected", exactly as `getConnection` documents.
  const readConnection = hooks.getConnection ?? storeGetConnection;
  const connectionRes = await readConnection(tcw, descriptor.id);
  const connection = connectionRes.ok ? connectionRes.data : null;
  if (!connection || connection.status !== "connected") return "not-connected";

  // A property read, never a prompt. A locked vault DEFERS: no error surfaces,
  // no attempt is burned, and the unlock re-arm below (or "Sync now") covers it.
  const unlocked = (hooks.isUnlocked ?? isSecretsUnlocked)(tcw);
  if (!unlocked) return "vault-locked";

  if (signal?.aborted) return "aborted";

  // A real attempt starts here — everything above was free.
  attempted = true;

  const readSecret =
    hooks.readRefreshToken ??
    ((t: TinyCloudWeb, d: ConnectorDescriptor) => getConnectorKey<SecretsErr>(t, d));
  const secretRes = await readSecret(tcw, descriptor);
  if (!secretRes.ok || typeof secretRes.data !== "string" || secretRes.data.length === 0) {
    breadcrumb("no usable refresh token in the vault");
    return "no-refresh-token";
  }
  // Memory only, for this run. Never logged, never re-persisted.
  const refreshToken = secretRes.data;

  const mint =
    hooks.mintAccessToken ??
    ((token: string, sig?: AbortSignal) =>
      mintGmeetAccessToken({
        backendUrl,
        sessionStore,
        refreshToken: token,
        signal: sig,
        fetchImpl: hooks.fetchImpl,
      }));

  const accessToken = await mint(refreshToken, signal);
  if (signal?.aborted) return "aborted";
  if (!accessToken) {
    breadcrumb("could not mint an access token");
    return "token-unavailable";
  }

  // The client re-mints ONCE on a 401 through the same proxy — the refresh
  // token never leaves this scope.
  const client = (hooks.createClient ?? defaultCreateClient)(
    accessToken,
    () => mint(refreshToken, signal),
    signal,
  );

  const result = await (hooks.runSync ?? syncGoogleMeet)({
    client,
    store: hooks.store ?? DEFAULT_STORE,
    tcw,
    signal,
  });

  if (!result.ok) {
    // The KIND only. Google's message can be long and is not ours to narrate
    // in a background lane; the Connectors surface is where detail belongs.
    breadcrumb(`session sync stopped: ${result.error.kind}`);
    return "sync-error";
  }
  return result.data.aborted ? "aborted" : "synced";
}

// ── React glue ───────────────────────────────────────────────────────

/**
 * Fire-and-forget start on mount. The sync never gates rendering.
 *
 * Also the registration seam for the ONE re-arm: a successful user-initiated
 * unlock (the lib-side choke point every unlock site funnels through), which is
 * what makes a deferred locked run retriable inside the same page load. A run
 * that already happened short-circuits on the latch, so the listener costs
 * nothing after the first success.
 *
 * Registration is effect-time (never module-load — that would leak across test
 * files), and the cleanup both unhooks the listener and ABORTS the controller,
 * so an in-flight sync stops between items when the shell unmounts.
 */
export function useGmeetSessionSync(options: Omit<GmeetSessionSyncOptions, "signal">): void {
  const { tcw, sessionStore, backendUrl, hooks } = options;
  useEffect(() => {
    if (!tcw) return;
    const controller = new AbortController();
    const current: GmeetSessionSyncOptions = {
      tcw,
      sessionStore,
      backendUrl,
      hooks,
      signal: controller.signal,
    };
    void maybeStartGmeetSessionSync(current);
    const off = onSecretsUnlocked(() => {
      void maybeStartGmeetSessionSync(current);
    });
    return () => {
      off();
      controller.abort();
    };
  }, [tcw, sessionStore, backendUrl, hooks]);
}

/**
 * The app-shell mount point. Renders NOTHING in every state — this lane has no
 * surface of its own; "Sync now" and the Connectors page own the visible ones.
 */
export function GmeetSessionSync(props: Omit<GmeetSessionSyncOptions, "signal">): null {
  useGmeetSessionSync(props);
  return null;
}
