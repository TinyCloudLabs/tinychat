import { createHash } from "node:crypto";
import { calendarMeetEvent, calendarOccurrenceKey, type EligibleCalendarEvent, type GoogleCalendarEvent } from "@tinyboilerplate/core";

// These two moved to @tinyboilerplate/core with calendar linking. The tests written before the move import them
// from here, and a pull request may not change an existing test's lines.
export { normalizeGoogleMeetUrl, type GoogleCalendarEvent } from "@tinyboilerplate/core";

export function calendarOccurrenceIdentity(tenant: string, subject: string, event: GoogleCalendarEvent): string | null {
  const identity = calendarOccurrenceKey(event);
  if (identity === null) return null;
  return createHash("sha256").update(JSON.stringify([1, tenant.toLowerCase(), subject, "primary", identity])).digest("hex");
}

export function eligibleCalendarEvent(event: GoogleCalendarEvent): EligibleCalendarEvent | null {
  const self = event.attendees?.find(attendee => attendee.self);
  if (self && self.responseStatus !== "accepted") return null;
  if (!event.organizer?.self && self?.responseStatus !== "accepted") return null;
  return calendarMeetEvent(event);
}

export const dispatchCutoff = (event: { start: number; end: number }) => Math.min(event.start + 15 * 60_000, event.end - 60_000);
export const inDispatchWindow = (event: { start: number; end: number }, now: number) => now >= event.start - 60_000 && now < dispatchCutoff(event);

export class GoogleCalendarError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
    readonly requiresReconnect = false,
    readonly retryable = false,
  ) { super(code); this.name = "GoogleCalendarError"; }
}
export interface GoogleCalendarPort {
  listEvents(accessToken: string, now?: number): Promise<GoogleCalendarEvent[]>;
  getEvent(accessToken: string, eventId: string): Promise<GoogleCalendarEvent | null>;
  probePrimary(accessToken: string): Promise<void>;
}

export class ExternalOperationLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit = 4) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await fn(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

export class GoogleCalendarClient implements GoogleCalendarPort {
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: ExternalOperationLimiter;
  constructor(options: { fetchImpl?: typeof fetch; limiter?: ExternalOperationLimiter; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limiter = options.limiter ?? new ExternalOperationLimiter();
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }
  private readonly timeoutMs: number;
  async probePrimary(accessToken: string): Promise<void> {
    await this.request(accessToken, "?maxResults=1&fields=items(id)");
  }
  async listEvents(accessToken: string, now = Date.now()): Promise<GoogleCalendarEvent[]> {
    const events: GoogleCalendarEvent[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    // No partial list escapes: incomplete discovery must never authorize a new send.
    do {
      const query = new URLSearchParams({ singleEvents: "true", showDeleted: "true", timeMin: new Date(now - 300_000).toISOString(), timeMax: new Date(now + 86_400_000).toISOString(), maxResults: "500" });
      if (pageToken) query.set("pageToken", pageToken);
      const page = await this.request(accessToken, `?${query}`) as { items?: GoogleCalendarEvent[]; nextPageToken?: string };
      if (page.items !== undefined && !Array.isArray(page.items)) throw new GoogleCalendarError("scan_incomplete", 0);
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      if (events.length > 500 || (pageToken && (events.length >= 500 || seen.has(pageToken) || seen.size >= 500))) throw new GoogleCalendarError("scan_incomplete", 0);
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return events;
  }
  async getEvent(accessToken: string, eventId: string): Promise<GoogleCalendarEvent | null> {
    try { return await this.request(accessToken, `/${encodeURIComponent(eventId)}`) as GoogleCalendarEvent; }
    catch (error) {
      if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }
  private request(accessToken: string, suffix: string): Promise<unknown> {
    return this.limiter.run(async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/primary/events${suffix}`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch { throw new GoogleCalendarError("calendar_transport", 0, null, false, true); }
      const data = await response.json().catch(() => null) as { error?: { errors?: { reason?: string }[] } } | null;
      if (!response.ok) {
        const reasons = data?.error?.errors?.map(error => error.reason) ?? [];
        const limited = response.status === 429 || (response.status === 403 && reasons.some(reason => reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || reason === "quotaExceeded"));
        const rawDelay = response.headers.get("retry-after");
        const delay = rawDelay === null ? NaN : /^\d+(?:\.\d+)?$/.test(rawDelay) ? Number(rawDelay) * 1000 : Date.parse(rawDelay) - Date.now();
        throw new GoogleCalendarError(limited ? "calendar_rate_limited" : response.status === 401 ? "calendar_unauthorized" : response.status === 403 ? "calendar_access_denied" : "calendar_unavailable", response.status, Number.isFinite(delay) ? Math.max(0, delay) : null, !limited && (response.status === 401 || response.status === 403), limited || response.status >= 500);
      }
      if (!data || typeof data !== "object") throw new GoogleCalendarError("calendar_invalid_response", 0, null, false, true);
      return data;
    });
  }
}
