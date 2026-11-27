// Calendar linking's own Google connection: a read-only consent of its own (purpose `calendar-link`), apart from
// the Google Meet connector and from Calendar autojoin.
//
// Custody is the Meet connector's: the refresh token lives in the user's vault (`tcw.secrets`) under its own key,
// never in the Meet secret and never on the server; access tokens come from the stateless backend refresh proxy
// and stay in memory. Whether linking is connected is a cross-device setting, so it reads without a vault unlock.
//
// What is read of the calendar: events of the primary calendar through a `fields` mask that asks for nobody's
// address, and one event by its id. Nothing here logs: no token, no event title, no invitee.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CALENDAR_LINK_EVENT_FIELDS, type GoogleCalendarEvent } from "@tinyboilerplate/core";

import { captureEvents } from "@/capture/captureEvents";
import { clearAllCalendarLinks } from "@/lib/calendarLink/calendarLinkRows";
import { scheduledSpace } from "@/lib/spaceQueue";
import { getSetting } from "@/lib/threadStore";
import { writeUserSetting } from "@/lib/voiceNotes/voiceNoteRows";

import {
  deleteConnectorKey, getConnectorKey, isSecretsUnlocked, saveConnectorKey, unlockSecrets,
  type SecretLocation, type SecretsErr,
} from "./connectorSecrets";
import { getConnection } from "./connectorStore";
import { encodeDesktopRefreshToken, googleRefreshGrant } from "./googleOAuthDesktop";

export const GOOGLE_CALENDAR_LINK_PURPOSE = "calendar-link";
/** Vault location of the linking token; never the Meet secret, never server custody. */
export const CALENDAR_LINK_SECRET: SecretLocation = { secretName: "REFRESH_TOKEN", secretScope: "google-calendar-link" };
/** The one Google scope linking needs: "See the events on Google calendars you own". */
export const GOOGLE_CALENDAR_LINK_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned.readonly";
/** The `settings` key of the connection's status. */
export const CALENDAR_LINK_STATUS_KEY = "calendar-link-status";
/** Events per events.list page: the API's maximum. */
export const CALENDAR_LINK_PAGE_SIZE = 250;

/** The authenticated backend proxy that mints an access token, and the one that asks Google to revoke. */
const GOOGLE_OAUTH_REFRESH_PATH = "/api/connectors/google/oauth/refresh";
const GOOGLE_OAUTH_REVOKE_PATH = "/api/connectors/google/oauth/revoke";
const CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/** One event is asked for with the item part of the list's mask. */
const CALENDAR_LINK_ITEM_FIELDS = CALENDAR_LINK_EVENT_FIELDS.slice(CALENDAR_LINK_EVENT_FIELDS.indexOf("items(") + "items(".length, -1);
const MEET_CONNECTOR_ID = "google-meet";
const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";
/** An access token this close to its end is not used for a new request. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

export type CalendarLinkStatus =
  | { state: "off" }
  | { state: "connected"; connectedAt: string }
  | { state: "needs-reconnect" };

export interface CalendarLinkDeps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  fetchImpl?: typeof fetch;
}

/**
 * Why the calendar was not read: linking is off, Google no longer honours the grant, the vault is locked, or the
 * request did not succeed (no session, the network, Google). Returned, never thrown; only `needs-reconnect` is
 * ever stored.
 */
export type CalendarUnreadable = "off" | "needs-reconnect" | "locked" | "unavailable";
export type CalendarRead<T> = { ok: true; data: T } | { ok: false; reason: CalendarUnreadable };

export interface CalendarEventsRead {
  events: GoogleCalendarEvent[];
  /** The events.list requests that returned a page. */
  calls: number;
  /** False when the page limit stopped the listing before Google's last page. */
  complete: boolean;
}

/** What the vault holds: the refresh token (desktop-encoded when the desktop client obtained it) and the backend's grant binding. */
interface StoredConnection { token: string; grant?: unknown }

/** One signed-in space's connection in this session. Memory only. */
interface Session {
  /** The status this session set, until the settings table holds it: a reader never waits for that write. */
  pending: CalendarLinkStatus | null;
  /** Every calendar request of this session rides on it; a disconnect aborts it. */
  reads: AbortController;
  access: { token: string; expiresAt: number } | null;
  minting: Promise<GoogleAccessMint> | null;
}

const sessions = new WeakMap<TinyCloudWeb, Session>();
const statusListeners = new Set<(tcw: TinyCloudWeb) => void>();

const unreadable = (reason: CalendarUnreadable) => ({ ok: false as const, reason });

function sessionOf(tcw: TinyCloudWeb): Session {
  let session = sessions.get(tcw);
  if (!session) {
    session = { pending: null, reads: new AbortController(), access: null, minting: null };
    sessions.set(tcw, session);
  }
  return session;
}

function parseStatus(stored: string | null): CalendarLinkStatus {
  try {
    const value = (stored === null ? null : JSON.parse(stored)) as { state?: unknown; connectedAt?: unknown } | null;
    if (value?.state === "connected" && typeof value.connectedAt === "string") return { state: "connected", connectedAt: value.connectedAt };
    if (value?.state === "needs-reconnect") return { state: "needs-reconnect" };
  } catch { /* not a status: off */ }
  return { state: "off" };
}

/**
 * From the cross-device `settings` table: readable without unlocking the vault. A status this session has just
 * set is returned at once, before its write has landed. Rejects when the setting cannot be read.
 */
export async function readCalendarLinkStatus(tcw: TinyCloudWeb): Promise<CalendarLinkStatus> {
  return sessions.get(tcw)?.pending ?? parseStatus(await getSetting(tcw, CALENDAR_LINK_STATUS_KEY));
}

/** Fires in this session after a connect, a disconnect or a needs-reconnect, with the space it happened in. */
export function onCalendarLinkStatus(listener: (tcw: TinyCloudWeb) => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

function notifyStatus(tcw: TinyCloudWeb): void {
  for (const listener of [...statusListeners]) {
    try { listener(tcw); } catch { /* a listener's failure is its own */ }
  }
}

/** The status every reader of this session sees from now on, then the setting. False when the setting was not saved. */
async function storeStatus(tcw: TinyCloudWeb, status: CalendarLinkStatus): Promise<boolean> {
  const session = sessionOf(tcw);
  session.pending = status;
  notifyStatus(tcw);
  try {
    await writeUserSetting(tcw, CALENDAR_LINK_STATUS_KEY, JSON.stringify(status));
  } catch {
    // The session keeps what it set; another device reads the older setting.
    return false;
  }
  if (session.pending === status) session.pending = null;
  return true;
}

async function readStoredConnection(tcw: TinyCloudWeb): Promise<StoredConnection | null> {
  const secret = await getConnectorKey<SecretsErr>(tcw, CALENDAR_LINK_SECRET).catch(() => null);
  if (!secret?.ok || typeof secret.data !== "string") return null;
  try {
    const value = JSON.parse(secret.data) as { v?: unknown; token?: unknown; grant?: unknown } | null;
    return value?.v === 1 && typeof value.token === "string" && value.token.length > 0
      ? { token: value.token, ...(value.grant === undefined ? {} : { grant: value.grant }) } : null;
  } catch {
    return null;
  }
}

/**
 * After a successful exchange. `scope` is the token response's; a grant without the calendar scope is refused
 * ("scope") and nothing is stored. The token goes to the vault (unlocking it if needed: the user has just asked
 * to connect), then the status is set.
 */
export async function saveCalendarLinkConnection(tcw: TinyCloudWeb,
  input: { refreshToken: string; desktop: boolean; scope: string | undefined; grant?: unknown }):
  Promise<{ ok: true } | { ok: false; reason: "locked" | "scope" | "storage"; message?: string }> {
  if (!(input.scope ?? "").split(/\s+/).includes(GOOGLE_CALENDAR_LINK_SCOPE)) return { ok: false, reason: "scope" };
  if (!isSecretsUnlocked(tcw)) {
    const unlock = await unlockSecrets<SecretsErr>(tcw);
    if (!unlock.ok) return { ok: false, reason: "locked", ...(unlock.error?.message ? { message: unlock.error.message } : {}) };
  }
  const stored: StoredConnection & { v: 1 } = {
    v: 1,
    token: input.desktop ? encodeDesktopRefreshToken(input.refreshToken) : input.refreshToken,
    ...(input.grant === undefined || input.grant === null ? {} : { grant: input.grant }),
  };
  const saved = await saveConnectorKey<SecretsErr>(tcw, CALENDAR_LINK_SECRET, JSON.stringify(stored));
  if (!saved.ok) return { ok: false, reason: "storage", ...(saved.error?.message ? { message: saved.error.message } : {}) };
  const session = sessionOf(tcw);
  // An access token of an earlier connection is another grant's.
  session.access = null;
  session.minting = null;
  if (await storeStatus(tcw, { state: "connected", connectedAt: new Date().toISOString() })) return { ok: true };
  // Not connected without its status: the token does not stay behind, and readers follow the stored setting again.
  await deleteConnectorKey<SecretsErr>(tcw, CALENDAR_LINK_SECRET).catch(() => undefined);
  session.pending = null;
  notifyStatus(tcw);
  return { ok: false, reason: "storage" };
}

export type GoogleAccessMint =
  | { ok: true; token: string; expiresAt: number }
  /** `invalid-grant`: Google no longer honours the refresh token. `unavailable`: anything else, the grant untouched. */
  | { ok: false; reason: "invalid-grant" | "unavailable" };

/**
 * A Google access token for a stored refresh token (as the vault holds it), through the authenticated backend
 * proxy. Nothing is persisted or logged: the refresh token rides one request body and the access token is
 * returned to the caller. Only Google's own `invalid_grant` (the proxy passes it on as a 400 or 401) says the
 * grant is gone; an expired TinyCloud One session, a dark route, a 5xx and a transport error do not.
 */
export async function mintGoogleAccessToken(opts: {
  backendUrl: string; sessionStore: SessionStore; stored: string; signal?: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<GoogleAccessMint> {
  const bearer = opts.sessionStore.getToken();
  if (!bearer || opts.sessionStore.isExpired()) return { ok: false, reason: "unavailable" };
  // `fetch` MUST stay bound to the global (see gmeetClient.ts's note).
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  try {
    const response = await fetchImpl(`${opts.backendUrl}${GOOGLE_OAUTH_REFRESH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE },
      body: JSON.stringify(googleRefreshGrant(opts.stored)),
      signal: opts.signal,
    });
    const body = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (!response.ok) {
      const gone = (response.status === 400 || response.status === 401) && body?.error === "invalid_grant";
      return { ok: false, reason: gone ? "invalid-grant" : "unavailable" };
    }
    const token = body?.access_token;
    if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "unavailable" };
    const lifetime = typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 0;
    return { ok: true, token, expiresAt: Date.now() + lifetime * 1000 };
  } catch {
    // Not narrated: a transport error can echo the request, which carried the refresh token.
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * An access token for the calendar: the one in memory while it lasts, else a new one. `rejected` is a token
 * Google has just answered 401 to: it is not handed out again.
 */
async function accessToken(deps: CalendarLinkDeps, session: Session, reads: AbortController, rejected?: string): Promise<CalendarRead<string>> {
  let status: CalendarLinkStatus;
  try { status = await readCalendarLinkStatus(deps.tcw); } catch { return unreadable("unavailable"); }
  if (reads.signal.aborted || status.state === "off") return unreadable("off");
  if (status.state === "needs-reconnect") return unreadable("needs-reconnect");
  if (session.access?.token === rejected) session.access = null;
  if (session.access && session.access.expiresAt - ACCESS_TOKEN_MARGIN_MS > Date.now()) return { ok: true, data: session.access.token };
  // A property read, never a prompt: linking in the background does not ask for an unlock.
  if (!isSecretsUnlocked(deps.tcw)) return unreadable("locked");
  const stored = await readStoredConnection(deps.tcw);
  if (reads.signal.aborted) return unreadable("off");
  if (!stored) return unreadable("unavailable");
  let minting = session.minting;
  if (!minting) {
    const started = mintGoogleAccessToken({ backendUrl: deps.backendUrl, sessionStore: deps.sessionStore, stored: stored.token,
      signal: reads.signal, fetchImpl: deps.fetchImpl }).finally(() => { if (session.minting === started) session.minting = null; });
    minting = session.minting = started;
  }
  const minted = await minting;
  // A disconnect meanwhile is the user's answer; a refusal that follows it is not a lost grant.
  if (reads.signal.aborted) return unreadable("off");
  if (!minted.ok) {
    if (minted.reason === "unavailable") return unreadable("unavailable");
    session.access = null;
    await storeStatus(deps.tcw, { state: "needs-reconnect" });
    return unreadable("needs-reconnect");
  }
  session.access = { token: minted.token, expiresAt: minted.expiresAt };
  return { ok: true, data: minted.token };
}

/** GET on the Calendar API with this session's access token. A 401 gets one fresh access token and one retry. */
async function openCalendar(deps: CalendarLinkDeps, caller?: AbortSignal): Promise<CalendarRead<(url: string) => Promise<CalendarRead<Response>>>> {
  const session = sessionOf(deps.tcw);
  const reads = session.reads;
  const first = await accessToken(deps, session, reads);
  if (!first.ok) return first;
  let token = first.data;
  // `fetch` MUST stay bound to the global (see gmeetClient.ts's note).
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const signal = caller ? AbortSignal.any([reads.signal, caller]) : reads.signal;
  const send = (url: string) => fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal });
  return { ok: true, data: async (url) => {
    try {
      let response = await send(url);
      if (response.status === 401) {
        const fresh = await accessToken(deps, session, reads, token);
        if (!fresh.ok) return fresh;
        token = fresh.data;
        response = await send(url);
      }
      return { ok: true, data: response };
    } catch {
      return unreadable(reads.signal.aborted ? "off" : "unavailable");
    }
  } };
}

/** What Google returned is an event when it carries an id; every other field is read tolerantly by the matcher. */
function isEvent(value: unknown): value is GoogleCalendarEvent {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0;
}

/**
 * The events of the primary calendar that end after `timeMin` and start before `timeMax` (UTC ms), each instance
 * of a series as its own event, in order of start, every page followed up to `maxPages`. The request asks for the
 * fields of CALENDAR_LINK_EVENT_FIELDS only.
 */
export async function listCalendarLinkEvents(deps: CalendarLinkDeps, window: { timeMin: number; timeMax: number },
  options: { signal?: AbortSignal; maxPages?: number } = {}): Promise<CalendarRead<CalendarEventsRead>> {
  if (!Number.isFinite(window.timeMin) || !Number.isFinite(window.timeMax)) return unreadable("unavailable");
  const calendar = await openCalendar(deps, options.signal);
  if (!calendar.ok) return calendar;
  const events: GoogleCalendarEvent[] = [];
  let calls = 0;
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      singleEvents: "true", showDeleted: "false", orderBy: "startTime",
      timeMin: new Date(window.timeMin).toISOString(), timeMax: new Date(window.timeMax).toISOString(),
      maxResults: String(CALENDAR_LINK_PAGE_SIZE), fields: CALENDAR_LINK_EVENT_FIELDS,
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await calendar.data(`${CALENDAR_EVENTS_URL}?${query}`);
    if (!response.ok) return response;
    if (!response.data.ok) return unreadable("unavailable");
    const page = await response.data.json().catch(() => null) as { items?: unknown; nextPageToken?: unknown } | null;
    if (page === null || typeof page !== "object") return unreadable("unavailable");
    calls += 1;
    if (Array.isArray(page.items)) events.push(...(page.items as unknown[]).filter(isEvent));
    pageToken = typeof page.nextPageToken === "string" && page.nextPageToken.length > 0 ? page.nextPageToken : undefined;
  } while (pageToken !== undefined && calls < (options.maxPages ?? Infinity));
  return { ok: true, data: { events, calls, complete: pageToken === undefined } };
}

/** One event of the primary calendar by its id, with the same fields as a listed one. Null: the event is gone (404 or 410). */
export async function readCalendarLinkEvent(deps: CalendarLinkDeps, eventId: string,
  options: { signal?: AbortSignal } = {}): Promise<CalendarRead<GoogleCalendarEvent | null>> {
  const calendar = await openCalendar(deps, options.signal);
  if (!calendar.ok) return calendar;
  const query = new URLSearchParams({ fields: CALENDAR_LINK_ITEM_FIELDS });
  const response = await calendar.data(`${CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}?${query}`);
  if (!response.ok) return response;
  if (response.data.status === 404 || response.data.status === 410) return { ok: true, data: null };
  if (!response.data.ok) return unreadable("unavailable");
  const event: unknown = await response.data.json().catch(() => null);
  return isEvent(event) ? { ok: true, data: event } : unreadable("unavailable");
}

/** Asks the backend's grant guard to let go of the token. It revokes at Google only when nothing else holds the grant. */
async function releaseGrant(input: { backendUrl: string; sessionStore: SessionStore; fetchImpl?: typeof fetch },
  stored: StoredConnection, connectorConnected: boolean): Promise<"revoked" | "kept" | "failed"> {
  const bearer = input.sessionStore.getToken();
  if (!bearer || input.sessionStore.isExpired()) return "failed";
  // `fetch` MUST stay bound to the global (see gmeetClient.ts's note).
  const fetchImpl = input.fetchImpl ?? fetch.bind(globalThis);
  try {
    const response = await fetchImpl(`${input.backendUrl}${GOOGLE_OAUTH_REVOKE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE },
      body: JSON.stringify({
        token: googleRefreshGrant(stored.token).refreshToken,
        purpose: GOOGLE_CALENDAR_LINK_PURPOSE,
        ...(stored.grant === undefined ? {} : { grant: stored.grant }),
        connectorConnected,
      }),
    });
    if (!response.ok) return "failed";
    const body = await response.json().catch(() => null) as { upstreamRevoked?: unknown } | null;
    return body?.upstreamRevoked === "ok" ? "revoked" : body?.upstreamRevoked === "kept" ? "kept" : "failed";
  } catch {
    // No thrown message: it can echo a request that carried the token.
    return "failed";
  }
}

/**
 * Whether the Google Meet connector holds a connection, from the connector's own state row (never a vault read).
 * A state that cannot be read counts as connected: the guard then keeps the grant rather than cut Meet off.
 */
async function meetConnectorConnected(tcw: TinyCloudWeb): Promise<boolean> {
  try {
    const connection = await getConnection(scheduledSpace(tcw), MEET_CONNECTOR_ID);
    return !connection.ok || connection.data?.status === "connected";
  } catch {
    return true;
  }
}

/**
 * Stop reading at once, ask the backend guard about upstream revoke, delete the secret, and (removeDetails) remove
 * `calendar_link` from every row. `upstream`: "revoked" | "kept" (another feature holds the Google grant, or the
 * guard could not rule that out) | "failed" | "no-token". Stored links stay unless `removeDetails`. Autojoin and
 * the Google Meet connector are not touched: the only request goes to the OAuth revoke route, with this
 * feature's own token.
 */
export async function disconnectCalendarLink(input: { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore; removeDetails: boolean; fetchImpl?: typeof fetch }):
  Promise<{ upstream: "revoked" | "kept" | "failed" | "no-token"; removedDetails: number | null }> {
  const { tcw } = input;
  const session = sessionOf(tcw);
  // Off first: every request under way is aborted, no new one starts, and the listeners (the link runner) drop their work.
  session.reads.abort();
  session.reads = new AbortController();
  session.access = null;
  session.minting = null;
  const marked = storeStatus(tcw, { state: "off" });

  let upstream: "revoked" | "kept" | "failed" | "no-token" = "no-token";
  // The user asked for this, so a locked vault may be unlocked to reach the token.
  const unlocked = isSecretsUnlocked(tcw) || (await unlockSecrets<SecretsErr>(tcw).catch(() => null))?.ok === true;
  const stored = unlocked ? await readStoredConnection(tcw) : null;
  if (stored) upstream = await releaseGrant(input, stored, await meetConnectorConnected(tcw));
  // Whatever the guard answered, this device and this space keep no token.
  await deleteConnectorKey<SecretsErr>(tcw, CALENDAR_LINK_SECRET).catch(() => undefined);
  // A setting that was not saved is tried once more: another device would otherwise still read "connected".
  if (!await marked && session.pending?.state === "off") await storeStatus(tcw, { state: "off" });

  let removedDetails: number | null = null;
  if (input.removeDetails) {
    removedDetails = await clearAllCalendarLinks(tcw);
    // Many rows changed at once: the Library lists again.
    if (removedDetails > 0) captureEvents.emit("library-changed");
  }
  return { upstream, removedDetails };
}
