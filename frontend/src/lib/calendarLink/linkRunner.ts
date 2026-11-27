// Links notes to the calendar event they were recorded in and stores the link on the note's row.
//
// One runner per signed-in space, shared by the capture surface and Settings. Work is asked for when a note is
// saved, changes or is opened (`consider`: calls are gathered for a moment, and the calendar is listed once for
// the batch), from Settings and after a connect (`backfill`: every note without a link, with one paged listing;
// with `since`, after a sync that brought meetings in, only the notes from then on),
// or by the user (`choices`, `pick`, and `refresh` when a linked note is opened).
//
// Which notes can link: a row with a time read as an instant, not a pasted transcript, not a combined meeting,
// and not a row whose time is only approximate (`datetime_exact` false). The note's interval is `started_at` to
// `started_at + duration_secs`. A Google Meet import knows its meeting by its code, a voice note by the code its
// call window gave, when it gave one; `matchCalendarEvent` (core) decides.
//
// Only `metadata.calendar_link` is written (and a Meet import's resolved `meeting_code`), never a title, a
// transcript or a speaker name. An automatic write applies only to a row without a `calendar_link`, so a link, a
// pending pick and the user's "none" are never written over, whatever this runner read before. A note that
// matches nothing gets no write. When the calendar cannot be read (not connected, the grant lost, a locked vault,
// the network) nothing is written and nothing is thrown; a note's automatic work is tried again on its next
// change, twice per session at most. It logs nothing: no event title, no invitee, no error message.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  ambiguousCalendarLink, CALENDAR_LINK_KEY, calendarLinkState, CONNECTORS_SQL_DB_NAME, EXO_MERGED_SOURCE, linkableCalendarEvent,
  linkedCalendarLink, matchCalendarEvent, normalizeMeetCode, normalizeZoomMeetingId, parseCalendarInstant, parseCalendarLink,
  refreshedCalendarLink, unlinkedCalendarLink,
  type CalendarLink, type CalendarLinkCandidate, type CalendarLinkConference, type GoogleCalendarEvent, type LinkableCalendarEvent,
} from "@tinyboilerplate/core";

import { captureEvents } from "@/capture/captureEvents";
import { CALL_PARTICIPANTS_KEY } from "@/capture/library/callParticipants";
import { onSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import { GMEET_MEETING_SOURCE } from "@/lib/connectors/gmeetNormalize";
import {
  listCalendarLinkEvents, onCalendarLinkStatus, readCalendarLinkEvent, readCalendarLinkStatus, type CalendarLinkDeps,
} from "@/lib/connectors/googleCalendarLink";
import { scheduledSpace } from "@/lib/spaceQueue";

import { calendarLinkingEnabled } from "./calendarLinkFeature";
import { ROW_METADATA, writeRowCalendarLink, writeRowMeetingCode } from "./calendarLinkRows";
import { createMeetCodes, type MeetCodeRead } from "./meetCodes";

/** A note's automatic attempts that may fail in one session: the first and one more. */
const AUTOMATIC_ATTEMPTS = 2;
/** How long `consider` gathers notes before the calendar is listed for them. */
const COALESCE_MS = 250;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A batch whose notes lie further apart than this lists the calendar per note. */
const BATCH_SPAN_MS = 2 * DAY_MS;
/** The backfill stops listing after this many pages and links what it read. */
const BACKFILL_MAX_PAGES = 40;
/** "Change…" offers events this far around the note… */
const CHOICE_WINDOW_MS = 6 * HOUR_MS;
/** …and this many at most. */
const MAX_CHOICES = 10;
/**
 * Google deletes a conference record 30 days after the meeting: an older import's space is not asked about, and a
 * Google Meet sync brings in nothing older (its own window is the same 30 days).
 */
export const MEET_RETENTION_MS = 30 * DAY_MS;
const SPACE_NAME = /^spaces\/[A-Za-z0-9_-]+$/;

export interface CalendarLinkNoteRef { id: string; source: string; sourceId: string }
export interface CalendarBackfillResult { considered: number; linked: number; ambiguous: number; listCalls: number }

export interface CalendarLinkRunner {
  /** A note was saved, changed or opened: link it, unless it has a `calendar_link` (any state) or linking is not connected. */
  consider(source: string, sourceId: string): void;
  /**
   * Link every note that has no `calendar_link`. Run once after connect and from Settings. Idempotent. Null: not connected / calendar unreadable.
   * With `since` (UTC ms) only the notes that started at or after it are read, and the calendar is listed for them
   * alone. A run under way answers a request it covers (every note, or notes from the same time or earlier);
   * any other request takes its turn after it.
   */
  backfill(options?: { since?: number }): Promise<CalendarBackfillResult | null>;
  /** "Change…": the linkable events around the note's time, best first. Null: the calendar cannot be read now. */
  choices(note: CalendarLinkNoteRef): Promise<CalendarLinkCandidate[] | null>;
  /** The user's pick: an event id, or null for "None of these" / "Unlink". Stored with `match.method: "user"`. False when nothing was written. */
  pick(note: CalendarLinkNoteRef, eventId: string | null): Promise<boolean>;
  /** A linked note was opened: read its event again and store what changed (or `event_missing`). */
  refresh(note: CalendarLinkNoteRef): void;
  cancelAll(): void;
  idle(): Promise<void>;
}

export interface CalendarLinkRunnerDeps extends CalendarLinkDeps {
  /** How long `consider` gathers notes; tests shorten it. */
  coalesceMs?: number;
}

/** A note as the runner reads it. The row's whole `metadata` is never read: it can hold a transcript. */
interface Note extends CalendarLinkNoteRef {
  /** UTC ms. `end` equals `start` when the note's length is unknown. */
  start: number;
  end: number;
  /** The row has a `calendar_link`, in whatever state. */
  linked: boolean;
  /** The meeting the note is known to be of. */
  conference: CalendarLinkConference | null;
  /** A Google Meet import whose code is not on its row yet: the space to ask Google about. */
  space: string | null;
}

const NOTE_COLUMNS = `id, source, source_id, started_at, duration_secs,
    json_extract(${ROW_METADATA}, '$.capture'), json_extract(${ROW_METADATA}, '$.datetime_exact'),
    json_type(${ROW_METADATA}, '$.${CALENDAR_LINK_KEY}'), json_extract(${ROW_METADATA}, '$.meeting_code'),
    json_extract(${ROW_METADATA}, '$.space'), json_extract(${ROW_METADATA}, '$.${CALL_PARTICIPANTS_KEY}.app'),
    json_extract(${ROW_METADATA}, '$.${CALL_PARTICIPANTS_KEY}.meeting_code')`;
const NOTE_BY_SOURCE = `SELECT ${NOTE_COLUMNS} FROM connector_meeting WHERE source = ? AND source_id = ?`;
const NOTE_BY_ID = `SELECT ${NOTE_COLUMNS} FROM connector_meeting WHERE id = ?`;
const UNLINKED = `SELECT ${NOTE_COLUMNS} FROM connector_meeting
  WHERE started_at IS NOT NULL AND json_type(${ROW_METADATA}, '$.${CALENDAR_LINK_KEY}') IS NULL`;
const UNLINKED_NOTES = `${UNLINKED} ORDER BY started_at DESC`;
const UNLINKED_NOTES_SINCE = `${UNLINKED} AND started_at >= ? ORDER BY started_at DESC`;
const LINK_BY_ID = `SELECT json_extract(${ROW_METADATA}, '$.${CALENDAR_LINK_KEY}') FROM connector_meeting WHERE id = ?`;

const keyOf = (source: string, sourceId: string) => `${source}\n${sourceId}`;

/** The row as a note that can link, or null: no time read as an instant, a pasted transcript, a combined meeting, an approximate time. */
function noteOf(row: unknown[]): Note | null {
  const [id, source, sourceId] = [String(row[0]), String(row[1]), String(row[2])];
  // Never read in the host time zone: a time without an offset is not a time.
  const start = typeof row[3] === "string" ? parseCalendarInstant(row[3]) : NaN;
  if (!Number.isFinite(start) || source === EXO_MERGED_SOURCE || row[5] === "pasted" || row[6] === 0 || row[6] === false) return null;
  const seconds = typeof row[4] === "number" && Number.isFinite(row[4]) && row[4] > 0 ? row[4] : 0;
  let conference: CalendarLinkConference | null = null;
  let space: string | null = null;
  if (source === GMEET_MEETING_SOURCE) {
    const code = normalizeMeetCode(row[8]);
    if (code) conference = { type: "hangoutsMeet", code };
    else if (typeof row[9] === "string" && SPACE_NAME.test(row[9])) space = row[9];
  } else if (row[10] === "google-meet") {
    const code = normalizeMeetCode(row[11]);
    if (code) conference = { type: "hangoutsMeet", code };
  } else if (row[10] === "zoom") {
    const code = normalizeZoomMeetingId(typeof row[11] === "number" ? String(row[11]) : row[11]);
    if (code) conference = { type: "zoom", code };
  }
  return { id, source, sourceId, start, end: start + Math.round(seconds * 1000), linked: row[7] !== null && row[7] !== undefined, conference, space };
}

/** An object as `json_extract` returns it (its JSON text); null when there is none or it cannot be read. */
function extracted(cell: unknown): unknown {
  try { return typeof cell === "string" ? JSON.parse(cell) as unknown : null; } catch { return null; }
}

/** The time `event` and the note share, in ms; for a note of unknown length, 1 when the event was going at its start. */
function sharedTime(note: Pick<Note, "start" | "end">, event: Pick<LinkableCalendarEvent, "start" | "end">): number {
  return note.end === note.start ? (event.start <= note.start && note.start < event.end ? 1 : 0)
    : Math.max(0, Math.min(note.end, event.end) - Math.max(note.start, event.start));
}

/**
 * The events of a long listing by time: `near(start, end)` returns those that touch the interval, without going
 * through them all for every note. What it returns is still the calendar's own events; the matcher reads them.
 */
function eventsByTime(events: readonly GoogleCalendarEvent[]): (start: number, end: number) => GoogleCalendarEvent[] {
  const linkable = events.flatMap((event) => linkableCalendarEvent(event) ?? []).sort((a, b) => a.start - b.start);
  /** The latest end among the events up to each one: an earlier event cannot reach further than this. */
  const reach: number[] = [];
  for (const [index, event] of linkable.entries()) reach.push(Math.max(event.end, reach[index - 1] ?? -Infinity));
  return (start, end) => {
    let low = 0;
    let high = linkable.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (linkable[middle]!.start <= end) low = middle + 1;
      else high = middle;
    }
    const near: GoogleCalendarEvent[] = [];
    for (let index = low - 1; index >= 0 && reach[index]! >= start; index--) {
      if (linkable[index]!.end >= start) near.push(linkable[index]!.event);
    }
    return near.reverse();
  };
}

/** Equal as JSON, whatever the order of the keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length && keys.every((key) => sameJson(left[key], right[key]));
}

/** An event as the picker shows it, cleaned as a stored link is. */
function candidateOf(event: GoogleCalendarEvent): CalendarLinkCandidate[] {
  const kept = linkedCalendarLink(event, "user", "");
  return kept.event_id && kept.start && kept.end ? [{ event_id: kept.event_id, title: kept.title ?? "", start: kept.start, end: kept.end }] : [];
}

/** What matching one note came to. `failed`: its meeting could not be asked about just now. `kept`: the row had a link by then. */
type LinkOutcome = "linked" | "ambiguous" | "none" | "kept" | "failed" | "stopped";

interface OwnedRunner {
  runner: CalendarLinkRunner;
  /** The space connected, disconnected or lost its grant: what this session concluded about its notes no longer holds. */
  connectionChanged(): void;
}

/** Counts the vault's unlocks: a note that could not be read for a locked vault may be tried again after one. */
let unlocks = 0;

function createRunner(deps: CalendarLinkRunnerDeps): OwnedRunner {
  const space = scheduledSpace(deps.tcw);
  const meetCodes = createMeetCodes(deps);
  const runs = new Set<Promise<unknown>>();
  /** Notes `consider` gathered for the next batch, by key. */
  const pending = new Map<string, { source: string; sourceId: string }>();
  /** Automatic attempts that failed, by note. */
  const failures = new Map<string, number>();
  /** The interval a note was matched for in this session: it is not matched again until that changes. */
  const settled = new Map<string, string>();
  /** Rows whose linked event was read again in this session. */
  const refreshed = new Set<string>();
  /** Moves when the work under way is no longer wanted: a cancel, or a change of the connection. */
  let epoch = 0;
  let controller = new AbortController();
  let waiting = false;
  /** Batches and backfills take turns: one listing of the calendar at a time. */
  let turn: Promise<unknown> = Promise.resolve();
  /** The backfills under way or waiting their turn, each with the time its notes start from (-Infinity: every note). */
  const backfills: { since: number; run: Promise<CalendarBackfillResult | null> }[] = [];
  /** The note this runner is announcing a write for: its own event is not a change to consider. */
  let announcing: string | null = null;
  let seenUnlocks = unlocks;

  const track = <T>(work: Promise<T>): Promise<T> => {
    const going = work.then(() => undefined, () => undefined).finally(() => runs.delete(going));
    runs.add(going);
    return work;
  };
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work);
    turn = next.then(() => undefined, () => undefined);
    return next;
  };
  const read = async (sql: string, params: unknown[]): Promise<unknown[][]> => {
    const rows = await space.sql.db(CONNECTORS_SQL_DB_NAME).query(sql, params as never[]);
    if (!rows.ok) throw new Error(rows.error.message);
    return rows.data.rows as unknown[][];
  };
  const stop = () => {
    epoch += 1;
    controller.abort();
    controller = new AbortController();
    pending.clear();
  };
  const afterUnlock = () => {
    if (seenUnlocks === unlocks) return;
    seenUnlocks = unlocks;
    failures.clear();
    refreshed.clear();
  };
  /** The open note reads its row again. */
  const announce = (note: { source: string; sourceId: string }) => {
    announcing = keyOf(note.source, note.sourceId);
    try { captureEvents.emit("library-changed", { source: note.source, sourceId: note.sourceId }); } finally { announcing = null; }
  };

  /**
   * The meeting the note is known to be of. A Google Meet import without a code on its row asks Google about its
   * space, when an event is there to compare it with, and keeps the answer on the row. Undefined: it could not
   * be asked just now, and matching on time alone could pick an event of another meeting.
   */
  const conferenceOf = async (note: Note, events: readonly GoogleCalendarEvent[], readCode: MeetCodeRead, live: () => boolean):
    Promise<CalendarLinkConference | null | undefined> => {
    if (note.conference || note.space === null || note.end < Date.now() - MEET_RETENTION_MS) return note.conference;
    if (!events.some((raw) => { const event = linkableCalendarEvent(raw); return event !== null && sharedTime(note, event) > 0; })) return null;
    const code = await readCode(note.space);
    if (code === undefined) return undefined;
    if (code === null) return null;
    if (live()) await writeRowMeetingCode(deps.tcw, note.id, code).catch(() => undefined);
    return { type: "hangoutsMeet", code };
  };

  /** Matches one note against the events read around it and stores the outcome. `quiet`: the caller announces. */
  const link = async (note: Note, events: readonly GoogleCalendarEvent[], readCode: MeetCodeRead, live: () => boolean, quiet: boolean):
    Promise<LinkOutcome> => {
    const conference = await conferenceOf(note, events, readCode, live);
    if (!live()) return "stopped";
    if (conference === undefined) return "failed";
    const match = matchCalendarEvent({ start: note.start, end: note.end, conference }, events);
    const found = match.kind === "linked"
      ? linkedCalendarLink(match.event, { method: match.method, confidence: match.confidence, overlap: match.overlap }, new Date().toISOString())
      : match.kind === "ambiguous" ? ambiguousCalendarLink(match.candidates) : null;
    const signature = `${note.start}:${note.end}`;
    if (found === null || (match.kind === "ambiguous" && found.candidates.length === 0)) {
      settled.set(keyOf(note.source, note.sourceId), signature);
      return "none";
    }
    const written = await writeRowCalendarLink(deps.tcw, note.id, found, "automatic");
    settled.set(keyOf(note.source, note.sourceId), signature);
    if (!written) return "kept";
    if (!quiet) announce(note);
    return match.kind === "linked" ? "linked" : "ambiguous";
  };

  const runBatch = async (refs: { source: string; sourceId: string }[]): Promise<void> => {
    const mine = epoch;
    const { signal } = controller;
    const live = () => epoch === mine;
    const fail = (key: string) => { if (live()) failures.set(key, (failures.get(key) ?? 0) + 1); };
    const notes: Note[] = [];
    for (const ref of refs) {
      try {
        const [row] = await read(NOTE_BY_SOURCE, [ref.source, ref.sourceId]);
        if (!live()) return;
        const note = row ? noteOf(row) : null;
        if (note && !note.linked && settled.get(keyOf(ref.source, ref.sourceId)) !== `${note.start}:${note.end}`) notes.push(note);
      } catch {
        fail(keyOf(ref.source, ref.sourceId));
      }
    }
    if (notes.length === 0) return;
    const earliest = notes.reduce((least, note) => Math.min(least, note.start), Infinity);
    const latest = notes.reduce((most, note) => Math.max(most, note.end), -Infinity);
    const readCode = meetCodes.reader(signal);
    let together: GoogleCalendarEvent[] | null = null;
    if (latest - earliest <= BATCH_SPAN_MS) {
      const listed = await listCalendarLinkEvents(deps, { timeMin: earliest - HOUR_MS, timeMax: latest + HOUR_MS }, { signal });
      if (!listed.ok) {
        for (const note of notes) fail(keyOf(note.source, note.sourceId));
        return;
      }
      together = listed.data.events;
    }
    for (const note of notes) {
      if (!live()) return;
      const key = keyOf(note.source, note.sourceId);
      try {
        let events = together;
        if (events === null) {
          const listed = await listCalendarLinkEvents(deps, { timeMin: note.start - HOUR_MS, timeMax: note.end + HOUR_MS }, { signal });
          if (!listed.ok) { fail(key); continue; }
          events = listed.data.events;
        }
        if (!live()) return;
        if (await link(note, events, readCode, live, false) === "failed") fail(key);
      } catch {
        fail(key);
      }
    }
  };

  const consider = (source: string, sourceId: string) => {
    const key = keyOf(source, sourceId);
    if (key === announcing) return;
    afterUnlock();
    if ((failures.get(key) ?? 0) >= AUTOMATIC_ATTEMPTS) return;
    pending.set(key, { source, sourceId });
    if (waiting) return;
    waiting = true;
    // Executor form: the frontend compiles against a lib without Promise.withResolvers.
    void track(new Promise<void>((resolve) => { setTimeout(resolve, deps.coalesceMs ?? COALESCE_MS); }).then(() => {
      waiting = false;
      const refs = [...pending.values()];
      pending.clear();
      return refs.length === 0 ? undefined : inTurn(() => runBatch(refs));
    }));
  };

  const runBackfill = async (since: number): Promise<CalendarBackfillResult | null> => {
    const mine = epoch;
    const { signal } = controller;
    const live = () => epoch === mine;
    try {
      if ((await readCalendarLinkStatus(deps.tcw)).state !== "connected" || !live()) return null;
      // Newest first: the notes the user is most likely to open are linked first. Stored times are ISO strings and
      // compare as text; a day of slack, and the exact test, cover any that are written with another offset.
      const rows = Number.isFinite(since) ? await read(UNLINKED_NOTES_SINCE, [new Date(since - DAY_MS).toISOString()]) : await read(UNLINKED_NOTES, []);
      const notes = rows.flatMap((row) => noteOf(row) ?? []).filter((note) => !note.linked && note.start >= since);
      if (!live()) return null;
      const result: CalendarBackfillResult = { considered: notes.length, linked: 0, ambiguous: 0, listCalls: 0 };
      if (notes.length === 0) return result;
      const earliest = notes.reduce((least, note) => Math.min(least, note.start), Infinity);
      const latest = notes.reduce((most, note) => Math.max(most, note.end), -Infinity);
      const listed = await listCalendarLinkEvents(deps, { timeMin: earliest - DAY_MS, timeMax: latest + DAY_MS }, { signal, maxPages: BACKFILL_MAX_PAGES });
      if (!listed.ok || !live()) return null;
      result.listCalls = listed.data.calls;
      const near = eventsByTime(listed.data.events);
      // A listing cut short ends at the start of its last timed event: a note that reaches past it was not read for.
      const readUntil = listed.data.complete ? Infinity : listed.data.events.reduce((latest, event) => {
        const start = event.start?.dateTime ? parseCalendarInstant(event.start.dateTime) : NaN;
        return start > latest ? start : latest;
      }, -Infinity);
      const readCode = meetCodes.reader(signal);
      let written = false;
      try {
        for (const note of notes) {
          if (note.end + HOUR_MS >= readUntil) continue;
          const outcome = await link(note, near(note.start, note.end), readCode, live, true).catch((): LinkOutcome => "failed");
          if (!live()) return null;
          if (outcome === "linked") result.linked += 1;
          else if (outcome === "ambiguous") result.ambiguous += 1;
          written ||= outcome === "linked" || outcome === "ambiguous";
        }
      } finally {
        // Many rows at once: the Library lists again, and no note is announced one by one.
        if (written) captureEvents.emit("library-changed");
      }
      return result;
    } catch {
      return null;
    }
  };

  const backfill = (options?: { since?: number }): Promise<CalendarBackfillResult | null> => {
    const since = options?.since !== undefined && Number.isFinite(options.since) ? options.since : -Infinity;
    const covering = backfills.find((entry) => entry.since <= since);
    if (covering) return covering.run;
    const entry: (typeof backfills)[number] = { since, run: track(inTurn(async () => {
      // Gone from the list as it ends: a request that arrives afterwards starts a run of its own.
      try { return await runBackfill(since); } finally { backfills.splice(backfills.indexOf(entry), 1); }
    })) };
    backfills.push(entry);
    return entry.run;
  };

  const choices = async (ref: CalendarLinkNoteRef): Promise<CalendarLinkCandidate[] | null> => {
    try {
      const [row] = await read(NOTE_BY_ID, [ref.id]);
      const note = row ? noteOf(row) : null;
      if (!note) return [];
      const listed = await listCalendarLinkEvents(deps, { timeMin: note.start - CHOICE_WINDOW_MS, timeMax: note.end + CHOICE_WINDOW_MS },
        { signal: controller.signal });
      if (!listed.ok) return null;
      return listed.data.events
        .flatMap((raw) => {
          const event = linkableCalendarEvent(raw);
          if (!event) return [];
          const shared = sharedTime(note, event);
          return [{ event, shared, distance: shared > 0 ? 0 : Math.max(event.start - note.end, note.start - event.end, 0) }];
        })
        // Those the note overlaps first, the longest overlap first; then the nearest in time.
        .sort((a, b) => a.distance - b.distance || b.shared - a.shared || a.event.start - b.event.start)
        .flatMap((ranked) => candidateOf(ranked.event.event))
        .slice(0, MAX_CHOICES);
    } catch {
      return null;
    }
  };

  const pick = async (ref: CalendarLinkNoteRef, eventId: string | null): Promise<boolean> => {
    try {
      let chosen: CalendarLink;
      if (eventId === null) chosen = unlinkedCalendarLink(new Date().toISOString());
      else {
        // The event as it is now, not as the picker listed it.
        const event = await readCalendarLinkEvent(deps, eventId, { signal: controller.signal });
        if (!event.ok || event.data === null || linkableCalendarEvent(event.data) === null) return false;
        chosen = linkedCalendarLink(event.data, "user", new Date().toISOString());
      }
      if (!await writeRowCalendarLink(deps.tcw, ref.id, chosen, "user")) return false;
      refreshed.add(ref.id);
      announce(ref);
      return true;
    } catch {
      return false;
    }
  };

  const refresh = (ref: CalendarLinkNoteRef) => {
    afterUnlock();
    if (refreshed.has(ref.id)) return;
    refreshed.add(ref.id);
    const mine = epoch;
    const { signal } = controller;
    void track((async () => {
      const [row] = await read(LINK_BY_ID, [ref.id]);
      const stored = parseCalendarLink(extracted(row?.[0]));
      if (!stored || calendarLinkState(stored) !== "linked" || stored.event_id === undefined || epoch !== mine) return;
      const event = await readCalendarLinkEvent(deps, stored.event_id, { signal });
      if (!event.ok || epoch !== mine) return;
      const next = refreshedCalendarLink(stored, event.data);
      if (sameJson(next, stored)) return;
      if (await writeRowCalendarLink(deps.tcw, ref.id, next, { refreshOf: stored.event_id })) announce(ref);
    })());
  };

  return {
    runner: {
      consider,
      backfill,
      choices: (note) => track(choices(note)),
      pick: (note, eventId) => track(pick(note, eventId)),
      refresh,
      cancelAll: stop,
      idle: async () => { while (runs.size > 0) await Promise.all(runs); },
    },
    connectionChanged: () => {
      stop();
      failures.clear();
      settled.clear();
      refreshed.clear();
    },
  };
}

const runners = new WeakMap<TinyCloudWeb, OwnedRunner>();
let listening = false;

/** One runner per signed-in space, shared by the capture surface and Settings. Undefined when the flag is off. */
export function calendarLinkRunner(deps: CalendarLinkRunnerDeps): CalendarLinkRunner | undefined {
  if (!calendarLinkingEnabled()) return undefined;
  if (!listening) {
    listening = true;
    // One listener for every space's runner, so a signed-out space's runner is not kept alive by it.
    onCalendarLinkStatus((tcw) => runners.get(tcw)?.connectionChanged());
    onSecretsUnlocked(() => { unlocks += 1; });
  }
  let owned = runners.get(deps.tcw);
  if (!owned) {
    owned = createRunner(deps);
    runners.set(deps.tcw, owned);
  }
  return owned.runner;
}
