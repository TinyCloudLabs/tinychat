/**
 * Calendar linking: which calendar event a recording belongs to, as pure functions.
 *
 * A note (a voice note, an upload, an imported meeting) links to at most one event INSTANCE of the
 * user's primary Google calendar. The link and the event's invitees are kept on the note's row as
 * `metadata.calendar_link`, apart from the people seen in the call (`call_participants`) and from the
 * names the user gave (`speaker_names`): an invitee was invited, which is not the same as having spoken.
 *
 * Matching, in this order:
 *   1. a meeting code both sides know, together with an overlap in time (the same Meet space serves
 *      every instance of a series, so the code alone does not pick the instance);
 *   2. else a clear overlap in time, never with an event whose known code differs from the note's;
 *   3. else the user picks, from at most CALENDAR_LINK_MAX_CANDIDATES events.
 *
 * Nothing here reads a clock, the network or the host time zone: instants are compared as UTC
 * milliseconds, and a time without an offset is not a time.
 */

export interface GoogleCalendarEventTime { dateTime?: string; date?: string; timeZone?: string }

export interface GoogleCalendarAttendee {
  self?: boolean;
  responseStatus?: string;
  email?: string;
  displayName?: string;
  organizer?: boolean;
  optional?: boolean;
  /** A room or a device, not a person. */
  resource?: boolean;
}

/** The fields of a Calendar API event this app reads. Autojoin and linking ask for different subsets. */
export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: GoogleCalendarEventTime;
  end?: GoogleCalendarEventTime;
  recurringEventId?: string;
  originalStartTime?: GoogleCalendarEventTime;
  iCalUID?: string;
  eventType?: string;
  transparency?: string;
  organizer?: { self?: boolean; email?: string; displayName?: string };
  attendees?: GoogleCalendarAttendee[];
  /** Google truncated the guest list (maxAttendees); a share check must not trust a partial list. */
  attendeesOmitted?: boolean;
  hangoutLink?: string;
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: { key?: { type?: string } };
    entryPoints?: { entryPointType?: string; uri?: string; meetingCode?: string }[];
  };
}

export interface EligibleCalendarEvent {
  eventId: string;
  title: string;
  start: number;
  end: number;
  meetingUrl: string;
}

// ── Helpers shared with calendar autojoin ────────────────────────────

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export function normalizeGoogleMeetUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "meet.google.com" || url.port || url.username || url.password) return null;
    if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname)) return null;
    return `https://meet.google.com${url.pathname.replace(/\/$/, "").toLowerCase()}`;
  } catch { return null; }
}

/** A Calendar timed value as UTC milliseconds; NaN unless it carries an offset (never read in the host time zone). */
export function parseCalendarInstant(value: string): number {
  return /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
}

/**
 * What tells one occurrence from another: the event id, or for an instance of a series
 * `[recurringEventId, originalStartTime]`, which stays the same when the instance is moved.
 * Null when the event has no id, or is an instance whose original start is not a timed instant.
 */
export function calendarOccurrenceKey(event: GoogleCalendarEvent): string | [string, string] | null {
  let key: string | [string, string] = event.id;
  if (event.recurringEventId) {
    const original = event.originalStartTime?.dateTime;
    const instant = original ? parseCalendarInstant(original) : NaN;
    if (!Number.isFinite(instant)) return null;
    key = [event.recurringEventId, new Date(instant).toISOString()];
  }
  if (!event.id) return null;
  return key;
}

function eventInterval(event: GoogleCalendarEvent): { start: number; end: number } | null {
  if (!event.start?.dateTime || !event.end?.dateTime) return null;
  const start = parseCalendarInstant(event.start.dateTime);
  const end = parseCalendarInstant(event.end.dateTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function meetUrlOf(event: GoogleCalendarEvent): string | null {
  return event.conferenceData?.entryPoints
    ?.filter(entry => entry.entryPointType === "video")
    .map(entry => normalizeGoogleMeetUrl(entry.uri)).find(Boolean) ?? normalizeGoogleMeetUrl(event.hangoutLink);
}

/** Timed, confirmed Meet occurrence, before applying the RSVP consent rule. */
export function calendarMeetEvent(event: GoogleCalendarEvent): EligibleCalendarEvent | null {
  if (event.status !== "confirmed") return null;
  const interval = eventInterval(event);
  if (!interval) return null;
  const meetingUrl = meetUrlOf(event);
  if (!meetingUrl) return null;
  return { eventId: event.id, ...interval, meetingUrl, title: event.summary?.slice(0, 512) || "Calendar meeting" };
}

// ── The stored link ──────────────────────────────────────────────────

/** The key of a note row's metadata that holds its calendar link. */
export const CALENDAR_LINK_KEY = "calendar_link";
/** The events a note waiting for the user's pick offers, at most. */
export const CALENDAR_LINK_MAX_CANDIDATES = 3;
export const CALENDAR_LINK_MAX_INVITEES = 100;
const MAX_TITLE_LENGTH = 512;
const MAX_INVITEE_NAME_LENGTH = 80;

/**
 * The `fields` mask of the events.list call linking makes. No address of anyone is asked for (an invitee is kept by
 * display name and response only), and neither is a description, a location, an attachment or the event's web link.
 */
export const CALENDAR_LINK_EVENT_FIELDS = "nextPageToken,items(id,status,summary,start,end,recurringEventId,originalStartTime,"
  + "iCalUID,eventType,transparency,organizer(self,displayName),attendees(self,displayName,responseStatus,organizer,optional,resource),"
  + "attendeesOmitted,hangoutLink,conferenceData(conferenceId,conferenceSolution/key/type,entryPoints(entryPointType,uri,meetingCode)))";

export type CalendarInviteeResponse = "accepted" | "declined" | "tentative" | "needsAction";
const INVITEE_RESPONSES: readonly CalendarInviteeResponse[] = ["accepted", "declined", "tentative", "needsAction"];

/** Someone the event invited. `name` is empty when the calendar gave no display name: still a person, never a candidate. */
export interface CalendarLinkInvitee {
  name: string;
  response: CalendarInviteeResponse;
  organizer?: true;
  self?: true;
  optional?: true;
}

export interface CalendarLinkConference { type: "hangoutsMeet" | "zoom"; code: string }
export interface CalendarLinkCandidate { event_id: string; title: string; start: string; end: string }

export interface CalendarLinkMatch {
  method: "meeting_code" | "time_overlap" | "user";
  confidence: "high" | "medium" | "user";
  /** The share of the note's length the event covers, 0 to 1. Absent for a user's pick. */
  overlap?: number;
  linked_at: string;
}

/**
 * `metadata.calendar_link`. Three states (`calendarLinkState`):
 *   linked     `event_id` and `match` are set;
 *   ambiguous  no `event_id`, no `match`, and `candidates` lists the events the user may pick from;
 *   none       no `event_id` and `match.method` is "user": the user unlinked the note or chose "None of these",
 *              and nothing links it again.
 */
export interface CalendarLink {
  v: 1;
  provider: "google";
  calendar: "primary";
  /** The event INSTANCE. */
  event_id?: string;
  recurring_event_id?: string;
  /** The instance's original start (ISO, UTC): with `recurring_event_id`, its identity even after it is moved. */
  original_start?: string;
  ical_uid?: string;
  title?: string;
  /** ISO, UTC. */
  start?: string;
  end?: string;
  conference?: CalendarLinkConference;
  invitees: CalendarLinkInvitee[];
  /** The calendar or this app cut the guest list short. */
  attendees_omitted: boolean;
  /** The event was deleted after it was linked; what is stored is the last snapshot. */
  event_missing?: true;
  match?: CalendarLinkMatch;
  candidates: CalendarLinkCandidate[];
}

export type CalendarLinkState = "linked" | "ambiguous" | "none";

export function calendarLinkState(link: CalendarLink): CalendarLinkState {
  if (link.event_id !== undefined && link.match !== undefined) return "linked";
  return link.match?.method === "user" ? "none" : "ambiguous";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

/** Spaces collapsed, control characters dropped, cut by code point. An address is not a name. */
function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = [...value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim()].slice(0, MAX_INVITEE_NAME_LENGTH).join("").trim();
  return name.includes("@") ? "" : name;
}

/** A Meet code as stored: lowercase `aaa-bbbb-ccc`. Accepts the ten letters without dashes. Null for anything else. */
export function normalizeMeetCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase();
  if (MEET_CODE.test(code)) return code;
  return /^[a-z]{10}$/.test(code) ? `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}` : null;
}

/** A Zoom meeting id as stored: its 9 to 11 digits, from the digits themselves (spaces or dashes allowed) or a `/j/<id>` link. */
export function normalizeZoomMeetingId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  const digits = value.replace(/[\s-]/g, "");
  if (/^\d{9,11}$/.test(digits)) return digits;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoomgov.com" || host.endsWith(".zoomgov.com"))) return null;
    return /^\/(?:j|w|wc\/join)\/(\d{9,11})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

/** The conference an event carries an id for: a Google Meet code, or a Zoom meeting id on one of its entry points. */
export function calendarEventConference(event: GoogleCalendarEvent): CalendarLinkConference | null {
  const data = event.conferenceData;
  if (data?.conferenceSolution?.key?.type === "hangoutsMeet") {
    const code = normalizeMeetCode(data.conferenceId);
    if (code) return { type: "hangoutsMeet", code };
  }
  const meet = meetUrlOf(event);
  if (meet) return { type: "hangoutsMeet", code: meet.slice(meet.lastIndexOf("/") + 1) };
  for (const entry of data?.entryPoints ?? []) {
    if (entry.entryPointType !== "video") continue;
    const id = normalizeZoomMeetingId(entry.uri);
    if (id) return { type: "zoom", code: id };
  }
  return null;
}

function parseConference(value: unknown): CalendarLinkConference | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.type === "hangoutsMeet" ? normalizeMeetCode(value.code) : value.type === "zoom" ? normalizeZoomMeetingId(value.code) : null;
  return code ? { type: value.type as CalendarLinkConference["type"], code } : undefined;
}

function inviteesOf(event: GoogleCalendarEvent): { invitees: CalendarLinkInvitee[]; omitted: boolean } {
  const invitees: CalendarLinkInvitee[] = [];
  const people = (event.attendees ?? []).filter(attendee => !attendee.resource);
  // An organizer who is not on the guest list still called the meeting.
  if (event.organizer && !people.some(attendee => attendee.organizer)) {
    invitees.push({ name: cleanName(event.organizer.displayName), response: "accepted", organizer: true, ...(event.organizer.self ? { self: true as const } : {}) });
  }
  for (const attendee of people) {
    invitees.push({
      name: cleanName(attendee.displayName),
      response: INVITEE_RESPONSES.find(known => known === attendee.responseStatus) ?? "needsAction",
      ...(attendee.organizer ? { organizer: true as const } : {}),
      ...(attendee.self ? { self: true as const } : {}),
      ...(attendee.optional ? { optional: true as const } : {}),
    });
  }
  const omitted = event.attendeesOmitted === true || invitees.length > CALENDAR_LINK_MAX_INVITEES;
  return { invitees: invitees.slice(0, CALENDAR_LINK_MAX_INVITEES), omitted };
}

/** What a link keeps of an event: never its description, location, attachments, web link or anyone's address. */
function snapshot(event: GoogleCalendarEvent): Pick<CalendarLink, "event_id" | "recurring_event_id" | "original_start" | "ical_uid" | "title" | "start" | "end" | "conference" | "invitees" | "attendees_omitted"> {
  const interval = eventInterval(event);
  const original = event.originalStartTime?.dateTime ? parseCalendarInstant(event.originalStartTime.dateTime) : NaN;
  const conference = calendarEventConference(event);
  const { invitees, omitted } = inviteesOf(event);
  return {
    event_id: event.id,
    ...(event.recurringEventId ? { recurring_event_id: event.recurringEventId } : {}),
    ...(Number.isFinite(original) ? { original_start: new Date(original).toISOString() } : {}),
    ...(event.iCalUID ? { ical_uid: event.iCalUID } : {}),
    title: (event.summary ?? "").replace(/\p{Cc}/gu, " ").trim().slice(0, MAX_TITLE_LENGTH),
    ...(interval ? { start: new Date(interval.start).toISOString(), end: new Date(interval.end).toISOString() } : {}),
    ...(conference ? { conference } : {}),
    invitees,
    attendees_omitted: omitted,
  };
}

function candidate(event: GoogleCalendarEvent): CalendarLinkCandidate | null {
  const kept = snapshot(event);
  return kept.event_id && kept.start && kept.end ? { event_id: kept.event_id, title: kept.title ?? "", start: kept.start, end: kept.end } : null;
}

/** A note linked to `event`: by the matcher (`match` as it returned it) or by the user's pick (`"user"`). */
export function linkedCalendarLink(event: GoogleCalendarEvent,
  match: { method: "meeting_code" | "time_overlap"; confidence: "high" | "medium"; overlap: number } | "user", linkedAt: string): CalendarLink {
  return {
    v: 1, provider: "google", calendar: "primary", ...snapshot(event),
    match: match === "user" ? { method: "user", confidence: "user", linked_at: linkedAt }
      : { method: match.method, confidence: match.confidence, overlap: Math.round(match.overlap * 100) / 100, linked_at: linkedAt },
    candidates: [],
  };
}

/** A note that waits for the user's pick among `events` (best first; the first CALENDAR_LINK_MAX_CANDIDATES are kept). */
export function ambiguousCalendarLink(events: readonly GoogleCalendarEvent[]): CalendarLink {
  return {
    v: 1, provider: "google", calendar: "primary", invitees: [], attendees_omitted: false,
    candidates: events.flatMap(event => candidate(event) ?? []).slice(0, CALENDAR_LINK_MAX_CANDIDATES),
  };
}

/** The user unlinked the note, or chose "None of these": it stays without an event. */
export function unlinkedCalendarLink(linkedAt: string): CalendarLink {
  return { v: 1, provider: "google", calendar: "primary", invitees: [], attendees_omitted: false,
    match: { method: "user", confidence: "user", linked_at: linkedAt }, candidates: [] };
}

/**
 * A linked note's link after its event was read again: the event's title, times, conference and invitees as they
 * are now (the link stays on the same `event_id`, however the event moved), or, for an event that is gone (`null`
 * or cancelled), the stored snapshot marked `event_missing`. How the note was matched is kept. A link that is not
 * linked, or an event with another id, is returned as it was.
 */
export function refreshedCalendarLink(link: CalendarLink, event: GoogleCalendarEvent | null): CalendarLink {
  if (calendarLinkState(link) !== "linked") return link;
  if (event === null || event.status === "cancelled") return link.event_missing ? link : { ...link, event_missing: true };
  if (event.id !== link.event_id) return link;
  const { event_missing: _gone, recurring_event_id: _series, original_start: _original, ical_uid: _uid, title: _title,
    start: _start, end: _end, conference: _conference, ...kept } = link;
  return { ...kept, ...snapshot(event) };
}

/** `value` as a stored link, read tolerantly; null when it is not one. */
export function parseCalendarLink(value: unknown): CalendarLink | null {
  if (!isRecord(value) || value.v !== 1 || value.provider !== "google" || value.calendar !== "primary") return null;
  const invitees = (Array.isArray(value.invitees) ? value.invitees as unknown[] : []).flatMap((entry): CalendarLinkInvitee[] => {
    if (!isRecord(entry)) return [];
    return [{
      name: cleanName(entry.name),
      response: INVITEE_RESPONSES.find(known => known === entry.response) ?? "needsAction",
      ...(entry.organizer === true ? { organizer: true as const } : {}),
      ...(entry.self === true ? { self: true as const } : {}),
      ...(entry.optional === true ? { optional: true as const } : {}),
    }];
  }).slice(0, CALENDAR_LINK_MAX_INVITEES);
  const candidates = (Array.isArray(value.candidates) ? value.candidates as unknown[] : []).flatMap((entry): CalendarLinkCandidate[] => {
    if (!isRecord(entry)) return [];
    const [id, start, end] = [text(entry.event_id), text(entry.start), text(entry.end)];
    return id && start && end ? [{ event_id: id, title: typeof entry.title === "string" ? entry.title : "", start, end }] : [];
  }).slice(0, CALENDAR_LINK_MAX_CANDIDATES);
  const stored = isRecord(value.match) ? value.match : null;
  const method = stored && (stored.method === "meeting_code" || stored.method === "time_overlap" || stored.method === "user") ? stored.method : null;
  const match: CalendarLinkMatch | undefined = method === null ? undefined : {
    method,
    confidence: method === "meeting_code" ? "high" : method === "time_overlap" ? "medium" : "user",
    ...(typeof stored!.overlap === "number" && Number.isFinite(stored!.overlap) ? { overlap: stored!.overlap } : {}),
    linked_at: text(stored!.linked_at) ?? "",
  };
  const eventId = match ? text(value.event_id) : undefined;
  // Neither linked, nor waiting on candidates, nor the user's "none": nothing to keep.
  if (!eventId && match?.method !== "user" && candidates.length === 0) return null;
  const conference = parseConference(value.conference);
  return {
    v: 1, provider: "google", calendar: "primary",
    ...(eventId ? {
      event_id: eventId,
      ...(text(value.recurring_event_id) ? { recurring_event_id: text(value.recurring_event_id) } : {}),
      ...(text(value.original_start) ? { original_start: text(value.original_start) } : {}),
      ...(text(value.ical_uid) ? { ical_uid: text(value.ical_uid) } : {}),
      title: typeof value.title === "string" ? value.title : "",
      ...(text(value.start) ? { start: text(value.start) } : {}),
      ...(text(value.end) ? { end: text(value.end) } : {}),
      ...(conference ? { conference } : {}),
      ...(value.event_missing === true ? { event_missing: true as const } : {}),
    } : {}),
    invitees: eventId ? invitees : [],
    attendees_omitted: eventId ? value.attendees_omitted === true : false,
    ...(match && (eventId || match.method === "user") ? { match } : {}),
    candidates: eventId || match?.method === "user" ? [] : candidates,
  };
}

/**
 * The invitees' display names that may go to the naming model as candidates: of a linked note only, never the
 * user's own entry, never an empty name, each once (compared without case). Addresses are never stored, so none
 * can be here.
 */
export function calendarLinkInviteeNames(link: CalendarLink | null): string[] {
  if (link === null || calendarLinkState(link) !== "linked") return [];
  const seen = new Set<string>();
  return link.invitees.flatMap(invitee => {
    const key = invitee.name.toLowerCase();
    if (invitee.self || invitee.name === "" || seen.has(key)) return [];
    seen.add(key);
    return [invitee.name];
  });
}

// ── Matching ─────────────────────────────────────────────────────────

/** A note as the matcher sees it: when it was recorded (UTC ms; `end` equal to `start` when its length is unknown) and the meeting it is known to be of. */
export interface CalendarNote {
  start: number;
  end: number;
  conference?: CalendarLinkConference | null;
}

export type CalendarEventMatch =
  | { kind: "linked"; event: GoogleCalendarEvent; method: "meeting_code"; confidence: "high"; overlap: number }
  | { kind: "linked"; event: GoogleCalendarEvent; method: "time_overlap"; confidence: "medium"; overlap: number }
  /** Best first, at most CALENDAR_LINK_MAX_CANDIDATES. */
  | { kind: "ambiguous"; candidates: GoogleCalendarEvent[] }
  | { kind: "none" };

/** A note counts as starting with an event when it starts no earlier than this before the event's start… */
export const CALENDAR_LINK_EARLY_START_MS = 10 * 60_000;
/** …and no later than this after it. */
export const CALENDAR_LINK_LATE_START_MS = 15 * 60_000;
/** The share of the note's length an event has to cover to match on time alone. */
export const CALENDAR_LINK_MIN_OVERLAP = 0.5;
/** An event that fails the time test is still offered to the user when it covers this share of the note… */
const NEAR_MISS_NOTE_SHARE = 0.25;
/** …or the note covers this share of the event. */
const NEAR_MISS_EVENT_SHARE = 0.5;

export interface LinkableCalendarEvent {
  event: GoogleCalendarEvent;
  start: number;
  end: number;
  conference: CalendarLinkConference | null;
}

/**
 * The event as one a note may link to, or null: it must be timed (an all-day event is not a meeting), not
 * cancelled, an ordinary event (not focus time, out of office or a working location), not declined by the user,
 * and not a "free" hold unless it carries a conference.
 */
export function linkableCalendarEvent(event: GoogleCalendarEvent): LinkableCalendarEvent | null {
  if (!event.id || event.status === "cancelled") return null;
  if (event.eventType !== undefined && event.eventType !== "default") return null;
  const interval = eventInterval(event);
  if (!interval) return null;
  if (event.attendees?.some(attendee => attendee.self && attendee.responseStatus === "declined")) return null;
  const conference = calendarEventConference(event);
  if (event.transparency === "transparent" && conference === null && !event.hangoutLink) return null;
  return { event, ...interval, conference };
}

interface Scored extends LinkableCalendarEvent {
  /** Milliseconds the event and the note share; for a note of unknown length, 1 when the event was going at its start. */
  shared: number;
  /** `shared` as a share of the note's length, 0 to 1. */
  overlap: number;
}

const bestFirst = (a: Scored, b: Scored) => b.overlap - a.overlap || b.shared - a.shared || a.start - b.start || (a.event.id < b.event.id ? -1 : 1);

/**
 * The event of `events` that `note` was recorded in. `events` is what the calendar returned for a window around
 * the note; events that cannot be linked (`linkableCalendarEvent`) are ignored.
 *
 * `meeting_code` (high): the note's known meeting and an event's conference are the same, and they overlap in
 * time; of several instances, the one that overlaps most.
 *
 * `time_overlap` (medium): exactly one event passes the time test (it covers at least half the note, or the note
 * starts between 10 minutes before and 15 minutes after the event's start and overlaps it) and that event has a
 * conference, or is the only linkable event the note overlaps. An event whose known conference differs from the
 * note's known conference is never matched on time, however large the overlap.
 *
 * `ambiguous`: several events pass, or the one that passes is not clear enough, or none passes but one comes
 * close. The user picks. Titles are never compared.
 */
export function matchCalendarEvent(note: CalendarNote, events: readonly GoogleCalendarEvent[]): CalendarEventMatch {
  if (!Number.isFinite(note.start) || !Number.isFinite(note.end)) return { kind: "none" };
  const length = Math.max(0, note.end - note.start);
  const overlapping = events.flatMap((raw): Scored[] => {
    const event = linkableCalendarEvent(raw);
    if (!event) return [];
    const shared = length === 0 ? (event.start <= note.start && note.start < event.end ? 1 : 0)
      : Math.max(0, Math.min(note.end, event.end) - Math.max(note.start, event.start));
    return shared > 0 ? [{ ...event, shared, overlap: length === 0 ? 1 : shared / length }] : [];
  });
  const known = note.conference ?? null;
  if (known) {
    const [byCode] = overlapping.filter(event => event.conference?.type === known.type && event.conference.code === known.code).sort(bestFirst);
    if (byCode) return { kind: "linked", event: byCode.event, method: "meeting_code", confidence: "high", overlap: byCode.overlap };
  }
  // A different known meeting is a different meeting.
  const candidates = (known ? overlapping.filter(event => event.conference === null) : overlapping).sort(bestFirst);
  const passing = candidates.filter(event => event.overlap >= CALENDAR_LINK_MIN_OVERLAP
    || (note.start >= event.start - CALENDAR_LINK_EARLY_START_MS && note.start <= event.start + CALENDAR_LINK_LATE_START_MS));
  const [only] = passing;
  if (passing.length === 1 && only && (only.conference !== null || !!only.event.hangoutLink || overlapping.length === 1)) {
    return { kind: "linked", event: only.event, method: "time_overlap", confidence: "medium", overlap: only.overlap };
  }
  const offered = passing.length > 0
    ? [...passing, ...candidates.filter(event => !passing.includes(event))]
    : candidates.filter(event => event.overlap >= NEAR_MISS_NOTE_SHARE || event.shared >= NEAR_MISS_EVENT_SHARE * (event.end - event.start));
  return offered.length === 0 ? { kind: "none" }
    : { kind: "ambiguous", candidates: offered.slice(0, CALENDAR_LINK_MAX_CANDIDATES).map(event => event.event) };
}
