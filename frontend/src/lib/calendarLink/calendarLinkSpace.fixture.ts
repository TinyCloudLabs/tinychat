// A space for the calendar linking tests: the naming tests' in-memory space (SQLite behind `tcw.sql`) with a vault
// behind `tcw.secrets`, the settings kept in memory, and a `fetch` that plays the backend's OAuth proxy, the
// Calendar API and the Meet API. Every request it was asked for is kept, so a test can say what went out.
import type { SessionStore } from "@tinyboilerplate/client";
import type { CalendarLink, GoogleCalendarEvent } from "@tinyboilerplate/core";

import { ensureSchema } from "@/lib/connectors/connectorStore";
import { GOOGLE_CALENDAR_LINK_SCOPE, saveCalendarLinkConnection } from "@/lib/connectors/googleCalendarLink";
import { namingSpace } from "@/lib/speakerNaming/namingSpace.fixture";
import { useLocalThreadStorage } from "@/lib/threadStore";

export const BACKEND = "http://backend.test";
export const CALENDAR_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Midnight UTC three days ago: recent enough for Google to still know a Meet import's space. */
const BASE = Math.floor((Date.now() - 3 * DAY) / DAY) * DAY;

/** An instant as a row or an event holds it: `hours` after the base day's midnight, `days` (negative: earlier) away from it. */
export const at = (hours: number, days = 0): string => new Date(BASE + days * DAY + Math.round(hours * HOUR)).toISOString();

/** A confirmed, timed event. */
export function timed(id: string, start: string, end: string, extra: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return { id, status: "confirmed", summary: `Event ${id}`, start: { dateTime: start }, end: { dateTime: end }, ...extra };
}

/** The conference fields of an event held in Google Meet under `code`. */
export const meet = (code: string): Partial<GoogleCalendarEvent> =>
  ({ conferenceData: { conferenceId: code, conferenceSolution: { key: { type: "hangoutsMeet" } } } });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const startOf = (event: GoogleCalendarEvent) => Date.parse(event.start?.dateTime ?? event.start?.date ?? "");
const endOf = (event: GoogleCalendarEvent) => Date.parse(event.end?.dateTime ?? event.end?.date ?? "");

export interface SentRequest { method: string; url: string; body: unknown; authorization: string | null }

export function calendarLinkSpace() {
  const space = namingSpace();
  const vault = new Map<string, string>();
  const slot = (name: string, options?: { scope?: string }) => `${options?.scope ?? ""}/${name}`;
  const locked = { ok: false as const, error: { code: "VAULT_LOCKED", message: "The vault is locked" } };
  const secrets = {
    isUnlocked: true,
    /** Whether `unlock` opens the vault. */
    unlockable: true,
    async unlock() {
      if (!secrets.unlockable) return locked;
      secrets.isUnlocked = true;
      return { ok: true as const, data: undefined };
    },
    async get(name: string, options?: { scope?: string }) {
      if (!secrets.isUnlocked) return locked;
      const value = vault.get(slot(name, options));
      return value === undefined ? { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } } : { ok: true as const, data: value };
    },
    async put(name: string, value: string, options?: { scope?: string }) {
      if (!secrets.isUnlocked) return locked;
      vault.set(slot(name, options), value);
      return { ok: true as const, data: undefined };
    },
    async delete(name: string, options?: { scope?: string }) {
      vault.delete(slot(name, options));
      return { ok: true as const, data: undefined };
    },
  };
  Object.assign(space.tcw, { secrets });
  useLocalThreadStorage(space.tcw);

  const requests: SentRequest[] = [];
  let minted = 0;
  const google = {
    /** The primary calendar, in any order. */
    events: [] as GoogleCalendarEvent[],
    /** Meet spaces this user can see: space id to meeting code. */
    spaces: new Map<string, string>(),
    /** The backend's refresh proxy. */
    refresh: (): Response | Promise<Response> => json({ access_token: `access-${++minted}`, expires_in: 3600 }),
    /** The backend's revoke route. */
    revoke: (): Response | Promise<Response> => json({ status: "disconnected", upstreamRevoked: "ok", reason: "last_holder" }),
    /** Answers an events.list request instead of the calendar when it gives a response; it may hold the request first. */
    list: (_authorization: string | null): Response | null | Promise<Response | null> => null,
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined, authorization });
    if (init?.signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
    if (url === `${BACKEND}/api/connectors/google/oauth/refresh`) return google.refresh();
    if (url === `${BACKEND}/api/connectors/google/oauth/revoke`) return google.revoke();
    const parsed = new URL(url);
    if (url.startsWith(`${CALENDAR_EVENTS}?`)) {
      const instead = await google.list(authorization);
      if (instead) return instead;
      const [from, to] = [Date.parse(parsed.searchParams.get("timeMin")!), Date.parse(parsed.searchParams.get("timeMax")!)];
      const size = Number(parsed.searchParams.get("maxResults"));
      const offset = Number(parsed.searchParams.get("pageToken") ?? 0);
      const inWindow = google.events.map((event) => ({ event, start: startOf(event), end: endOf(event) }))
        .filter((entry) => entry.end > from && entry.start < to).sort((a, b) => a.start - b.start).map((entry) => entry.event);
      return json({ items: inWindow.slice(offset, offset + size), ...(offset + size < inWindow.length ? { nextPageToken: String(offset + size) } : {}) });
    }
    if (url.startsWith(`${CALENDAR_EVENTS}/`)) {
      const event = google.events.find((entry) => entry.id === decodeURIComponent(parsed.pathname.split("/").pop()!));
      return event ? json(event) : json({ error: { code: 404 } }, 404);
    }
    if (url.startsWith("https://meet.googleapis.com/v2/spaces/")) {
      const code = google.spaces.get(decodeURIComponent(parsed.pathname.split("/").pop()!));
      return code ? json({ meetingCode: code }) : json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
    }
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;

  const sessionStore = { getToken: () => "session", isExpired: () => false, clear: () => {} } as unknown as SessionStore;
  const stored = (rowId: string) => space.sqlite.query("SELECT title, metadata, updated_at FROM connector_meeting WHERE id = ?")
    .get(rowId) as { title: string; metadata: string | null; updated_at: string };

  const meta = (rowId: string): { calendar_link?: CalendarLink } & Record<string, unknown> => JSON.parse(stored(rowId).metadata ?? "{}");
  return {
    ...space, secrets, vault, google, requests, fetchImpl, sessionStore,
    deps: { tcw: space.tcw, backendUrl: BACKEND, sessionStore, fetchImpl, coalesceMs: 0 },
    /** A note of `source`, recorded from `startedAt` for `durationSecs`. Returns the ref the runner is asked with. */
    async add(source: string, sourceId: string, startedAt: string | null, durationSecs: number | null, metadata: Record<string, unknown> | null = {}) {
      await ensureSchema(space.tcw);
      const id = `${source}-${sourceId}`;
      space.sqlite.prepare(`INSERT INTO connector_meeting (id, source, source_id, title, started_at, duration_secs, participants, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'Recording', ?, ?, '[]', ?, ?, ?)`).run(id, source, sourceId, startedAt, durationSecs,
        metadata === null ? null : JSON.stringify(metadata), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      return { id, source, sourceId };
    },
    stored,
    /** The row's metadata as stored. */
    meta,
    /** The row's `calendar_link` as stored. */
    link: (rowId: string) => meta(rowId).calendar_link,
    /** The events.list requests sent so far. */
    lists: () => requests.filter((request) => request.url.startsWith(`${CALENDAR_EVENTS}?`)),
    /** The SQL writes to note rows so far. */
    writes: () => space.statements.filter((sql) => sql.startsWith("UPDATE connector_meeting")),
    /** Calendar linking connected, as after a successful exchange. */
    async connect(input: { desktop?: boolean; grant?: unknown } = {}) {
      await ensureSchema(space.tcw);
      return saveCalendarLinkConnection(space.tcw, { refreshToken: "refresh-link", desktop: input.desktop ?? false, scope: `openid ${GOOGLE_CALENDAR_LINK_SCOPE}`, grant: input.grant });
    },
    /** The Google Meet connector connected, with its own token in the vault. */
    async connectMeet() {
      await ensureSchema(space.tcw);
      space.sqlite.prepare("INSERT INTO connector_state (connector_id, status, item_count, updated_at) VALUES ('google-meet', 'connected', 0, ?)").run(new Date().toISOString());
      vault.set(slot("REFRESH_TOKEN", { scope: "google-meet" }), "refresh-meet");
    },
  };
}

export type CalendarLinkSpace = ReturnType<typeof calendarLinkSpace>;
