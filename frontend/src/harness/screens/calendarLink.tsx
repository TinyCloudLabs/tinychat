// A note's calendar event, in a build with calendar linking (VITE_CALENDAR_LINKING), in the real shell over the
// fixture space: a meeting linked to its event, and one where two events fit and the note asks which it was.
import { calendarLinkingEnabled } from "@/lib/calendarLink/calendarLinkFeature";
import { CALENDAR_LINK_STATUS_KEY } from "@/lib/connectors/googleCalendarLink";
import { LIBRARY_ROWS } from "../fixtures/library";
import { CaptureShell } from "./capture";
import type { HarnessScreen } from "../screen";

const NOTE_ID = "meeting-weekly";
const meeting = LIBRARY_ROWS.find((row) => row.id === NOTE_ID);
const minutesAfterStart = (minutes: number) => new Date(Date.parse(meeting?.startedAt ?? "") + minutes * 60_000).toISOString();
const WEEKLY = { event_id: "ev-weekly", title: "Weekly sync", start: minutesAfterStart(0), end: minutesAfterStart(30) };
const PLANNING = { event_id: "ev-planning", title: "Release planning", start: minutesAfterStart(30), end: minutesAfterStart(60) };
const link = (patch: Record<string, unknown>) => ({ v: 1, provider: "google", calendar: "primary", invitees: [], attendees_omitted: false, candidates: [], ...patch });
const rowsWith = (calendarLink: Record<string, unknown>): typeof LIBRARY_ROWS =>
  LIBRARY_ROWS.map((row) => row.id === NOTE_ID ? { ...row, metadata: { ...row.metadata, calendar_link: calendarLink } } : row);

const LINKED_ROWS = rowsWith(link({ ...WEEKLY, match: { method: "time_overlap", confidence: "medium", overlap: 0.96, linked_at: minutesAfterStart(32) } }));
const AMBIGUOUS_ROWS = rowsWith(link({ candidates: [WEEKLY, PLANNING] }));

const NOTE = { group: "calendarLink", layout: "pane", displayTitle: true, platform: "ios", path: `/chat/capture/library/${NOTE_ID}` } as const;
const shown = (state: string) => `[data-testid="calendar-link"][data-state="${state}"]`;
/** The fixture space has its calendar linked: the note asks and offers what only a connected calendar allows. */
const CONNECTED = { [CALENDAR_LINK_STATUS_KEY]: JSON.stringify({ state: "connected", connectedAt: minutesAfterStart(-60) }) };

/** Registered only in a build that links calendar events: without the flag the note shows nothing of them. */
export const calendarLinkScreens: HarnessScreen[] = calendarLinkingEnabled() ? [
  { ...NOTE, id: "calendarLink-linked", readyWhen: shown("linked"), render: () => <CaptureShell library rows={LINKED_ROWS} settings={CONNECTED} /> },
  { ...NOTE, id: "calendarLink-ambiguous", readyWhen: shown("ambiguous"), render: () => <CaptureShell library rows={AMBIGUOUS_ROWS} settings={CONNECTED} /> },
] : [];
