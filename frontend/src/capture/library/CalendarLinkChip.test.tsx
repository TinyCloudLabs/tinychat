// A note's calendar event on the note page: the linked event with Change… and Unlink, the question when more than
// one event fits, the picker, what is left of them while the calendar is not connected, and nothing at all in a
// build without calendar linking or without a runner.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { CalendarLinkCandidate } from "@tinyboilerplate/core";
import { installDom } from "@/test/dom";
import type { CalendarLinkNoteRef, CalendarLinkRunner } from "@/lib/calendarLink/linkRunner";
import type { CalendarLinkStatus } from "@/lib/connectors/googleCalendarLink";
import { CALENDAR_LINK_COPY as COPY, CalendarLinkChip, calendarEventWhen } from "./CalendarLinkChip";
import type { LibraryItem } from "./LibraryRow";
import { NoteDetailView } from "./NoteDetailView";

// Whether the calendar is connected is this file's to say, so the hook is loaded after the stand-in is in place.
// bun's mock.module is process-wide, so the real module is put back when this file is done.
const CONNECTED: CalendarLinkStatus = { state: "connected", connectedAt: "2026-10-01T08:00:00.000Z" };
let status: () => Promise<CalendarLinkStatus>;
const statusListeners = new Set<() => void>();
const actualStatus = { ...(await import("@/lib/connectors/googleCalendarLink")) };
afterAll(() => { mock.module("@/lib/connectors/googleCalendarLink", () => actualStatus); });
mock.module("@/lib/connectors/googleCalendarLink", () => ({
  ...actualStatus,
  readCalendarLinkStatus: () => status(),
  onCalendarLinkStatus: (listener: () => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
}));
const { useCalendarLink } = await import("./useCalendarLink");
const TCW = {} as TinyCloudWeb;

const ITEM: LibraryItem = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Call", startedAt: "2026-10-06T09:02:00.000Z", durationSecs: 1500 };
const REF: CalendarLinkNoteRef = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1" };
const WEEKLY: CalendarLinkCandidate = { event_id: "ev-weekly", title: "Weekly sync", start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T09:30:00.000Z" };
const PLANNING: CalendarLinkCandidate = { event_id: "ev-planning", title: "Planning", start: "2026-10-06T09:30:00.000Z", end: "2026-10-06T10:00:00.000Z" };
const when = (event: CalendarLinkCandidate) => calendarEventWhen(event.start, event.end, new Date())!;
const stored = (patch: Record<string, unknown>) => ({ v: 1, provider: "google", calendar: "primary", invitees: [], attendees_omitted: false, candidates: [], ...patch });
const linked = (patch: Record<string, unknown> = {}) => ({ transcription_outcome: "transcribed", calendar_link: stored({
  event_id: WEEKLY.event_id, title: WEEKLY.title, start: WEEKLY.start, end: WEEKLY.end,
  match: { method: "time_overlap", confidence: "medium", overlap: 0.92, linked_at: "2026-10-06T10:00:00.000Z" }, ...patch }) });
const ambiguous = () => ({ calendar_link: stored({ candidates: [WEEKLY, PLANNING] }) });
const userNone = () => ({ calendar_link: stored({ match: { method: "user", confidence: "user", linked_at: "2026-10-06T10:00:00.000Z" } }) });
const NO_LINK = { transcription_outcome: "transcribed" };

let calls: string[];
let picks: { note: CalendarLinkNoteRef; eventId: string | null }[];
/** `choices`: what "Change…" finds; `saves`: whether a pick is written. */
const runner = (options: { choices?: CalendarLinkCandidate[] | null; saves?: boolean | "throws" } = {}): CalendarLinkRunner => ({
  consider: (source, sourceId) => { calls.push(`consider ${source} ${sourceId}`); },
  backfill: async () => null,
  choices: async (note) => { calls.push(`choices ${note.id}`); return options.choices === undefined ? [WEEKLY, PLANNING] : options.choices; },
  pick: async (note, eventId) => {
    picks.push({ note, eventId });
    if (options.saves === "throws") throw new Error("down");
    return options.saves ?? true;
  },
  refresh: (note) => { calls.push(`refresh ${note.id}`); },
  cancelAll: () => {},
  idle: async () => {},
});

let root: Root | null = null;
let cleanup: (() => void) | null = null;
// Set on `import.meta.env` itself, as the suggested-names tests set their flag.
beforeEach(() => {
  import.meta.env.VITE_CALENDAR_LINKING = "true";
  status = async () => CONNECTED;
  calls = [];
  picks = [];
});
afterEach(async () => {
  await act(async () => root?.unmount());
  cleanup?.();
  root = null;
  cleanup = null;
  delete import.meta.env.VITE_CALENDAR_LINKING;
});

/** The hook and the chip as the note page joins them. */
function Probe(props: { runner: CalendarLinkRunner | undefined; item: LibraryItem | null; metadata: Record<string, unknown> | null }) {
  return <CalendarLinkChip calendarLink={useCalendarLink({ tcw: TCW, runner: props.runner, row: props.item, metadata: props.metadata })} />;
}
/** `with_` null: the surface has no runner. */
const mount = async (metadata: Record<string, unknown> | null, with_: CalendarLinkRunner | null = runner(), item: LibraryItem | null = ITEM) => {
  cleanup ??= installDom();
  if (root === null) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(<Probe runner={with_ ?? undefined} item={item} metadata={metadata} />));
};
const one = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const all = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const click = (el: HTMLElement | null | undefined) => { expect(el).toBeTruthy(); return act(async () => el!.click()); };
const text = () => document.body.textContent ?? "";

test("without the build flag or without a runner nothing renders or runs, even for a note with a stored link", async () => {
  await mount(linked(), null);
  expect(one("calendar-link")).toBeNull();
  delete import.meta.env.VITE_CALENDAR_LINKING;
  await mount(linked(), runner());
  expect(one("calendar-link")).toBeNull();
  expect(text()).not.toContain("Weekly sync");
  expect(calls).toEqual([]);
});

test("a linked note shows the event's title and its time in the viewer's zone, with Change… and Unlink under one named control", async () => {
  await mount(linked());
  const chip = one("calendar-link-chip")!;
  expect(chip.textContent).toContain(`Weekly sync · ${when(WEEKLY)}`);
  expect(chip.getAttribute("aria-label")).toBe(COPY.options(`Weekly sync · ${when(WEEKLY)}`));
  expect(one("calendar-link-change")!.textContent).toBe("Change…");
  expect(one("calendar-link-unlink")!.textContent).toBe("Unlink");
  expect(one("calendar-link-missing")).toBeNull();
});

test("an event without a title is shown as Calendar event", async () => {
  await mount(linked({ title: "" }));
  expect(one("calendar-link-chip")!.textContent).toContain(`Calendar event · ${when(WEEKLY)}`);
});

test("Unlink saves the user's choice of no event", async () => {
  await mount(linked());
  await click(one("calendar-link-unlink"));
  expect(picks).toEqual([{ note: REF, eventId: null }]);
});

test("Change… lists the events around the note's time, and a click saves that event", async () => {
  await mount(linked());
  await click(one("calendar-link-change"));
  expect(all("calendar-link-choice").map((el) => el.textContent)).toEqual([`Weekly sync · ${when(WEEKLY)}`, `Planning · ${when(PLANNING)}`]);
  expect(one("calendar-link-none")!.textContent).toBe("None of these");
  await click(all("calendar-link-choice")[1]);
  expect(picks).toEqual([{ note: REF, eventId: "ev-planning" }]);
  // Saved: the picker closes.
  expect(one("calendar-link-picker")).toBeNull();
});

test("Change… says the calendar is being read until the events arrive", async () => {
  const arriving = Promise.withResolvers<CalendarLinkCandidate[]>();
  await mount(linked(), { ...runner(), choices: () => arriving.promise });
  await click(one("calendar-link-change"));
  expect(one("calendar-link-picker")!.getAttribute("data-state")).toBe("loading");
  expect(text()).toContain(COPY.loading);
  await act(async () => arriving.resolve([WEEKLY]));
  expect(all("calendar-link-choice")).toHaveLength(1);
});

test("a calendar that cannot be read says so and writes nothing", async () => {
  await mount(linked(), runner({ choices: null }));
  await click(one("calendar-link-change"));
  expect(text()).toContain("Your calendar can’t be read right now.");
  expect(all("calendar-link-choice")).toEqual([]);
  expect(one("calendar-link-none")).toBeNull();
  await click(one("calendar-link-cancel"));
  expect(one("calendar-link-picker")).toBeNull();
  expect(picks).toEqual([]);
  // The link shown is the stored one still.
  expect(one("calendar-link-chip")!.textContent).toContain("Weekly sync");
});

test("no events around the note's time says so and still offers None of these", async () => {
  await mount(linked(), runner({ choices: [] }));
  await click(one("calendar-link-change"));
  expect(text()).toContain("No meetings around this time.");
  await click(one("calendar-link-none"));
  expect(picks).toEqual([{ note: REF, eventId: null }]);
});

test("more than one fitting event asks which meeting it was: each stored candidate, then None of these", async () => {
  await mount(ambiguous());
  const question = one("calendar-link-question")!;
  expect(question.textContent).toContain("Which meeting was this?");
  expect([...question.querySelectorAll("button")].map((el) => el.textContent)).toEqual([`Weekly sync · ${when(WEEKLY)}`, `Planning · ${when(PLANNING)}`, "None of these"]);
  await click(all("calendar-link-choice")[0]);
  await click(one("calendar-link-none"));
  expect(picks).toEqual([{ note: REF, eventId: "ev-weekly" }, { note: REF, eventId: null }]);
  // Asking is not a link: nothing was read from the calendar for it.
  expect(calls).toEqual([]);
});

test("an event deleted from the calendar keeps its stored title and says it is no longer there", async () => {
  await mount(linked({ event_missing: true }));
  expect(one("calendar-link-chip")!.textContent).toContain(`Weekly sync · ${when(WEEKLY)}`);
  expect(one("calendar-link-missing")!.textContent).toBe("No longer on your calendar");
});

test("a pick that is not saved, or fails, leaves what was shown and says so", async () => {
  for (const saves of [false, "throws"] as const) {
    await mount(linked(), runner({ saves }));
    await click(one("calendar-link-change"));
    await click(all("calendar-link-choice")[1]);
    expect(one("calendar-link-failed")!.textContent).toBe("Couldn’t save. Try again.");
    expect(one("calendar-link-failed")!.getAttribute("role")).toBe("alert");
    expect(all("calendar-link-choice")).toHaveLength(2);
    expect(one("calendar-link-chip")!.textContent).toContain("Weekly sync");
    await act(async () => root!.unmount());
    root = null;
  }
});

test("a note the user chose no event for can be linked again, and is never linked for them", async () => {
  await mount(userNone());
  expect(one("calendar-link-chip")).toBeNull();
  expect(one("calendar-link-open")!.textContent).toBe("Link to a calendar event…");
  expect(calls).toEqual([]);
  await click(one("calendar-link-open"));
  await click(all("calendar-link-choice")[1]);
  expect(picks).toEqual([{ note: REF, eventId: "ev-planning" }]);
});

const NOT_CONNECTED: [string, () => Promise<CalendarLinkStatus>][] = [
  ["off", async () => ({ state: "off" })],
  ["needs-reconnect", async () => ({ state: "needs-reconnect" })],
  ["unreadable", async () => { throw new Error("down"); }],
  ["not read yet", () => new Promise<CalendarLinkStatus>(() => {})],
];
for (const [name, read] of NOT_CONNECTED) {
  test(`calendar ${name}: a stored link still shows, with Unlink alone, and its event is not read again`, async () => {
    status = read;
    await mount(linked({ event_missing: true }));
    expect(one("calendar-link-chip")!.textContent).toContain(`Weekly sync · ${when(WEEKLY)}`);
    expect(one("calendar-link-missing")).not.toBeNull();
    expect(one("calendar-link-change")).toBeNull();
    await click(one("calendar-link-unlink"));
    expect(picks).toEqual([{ note: REF, eventId: null }]);
    expect(calls).toEqual([]);
  });

  test(`calendar ${name}: nothing is asked or offered on a note without a link`, async () => {
    status = read;
    for (const metadata of [ambiguous(), NO_LINK, userNone()]) {
      await mount(metadata);
      expect(one("calendar-link")).toBeNull();
    }
    expect(text()).not.toContain("Which meeting was this?");
    expect(calls).toEqual([]);
  });
}

test("connecting while a note is open offers the link and asks the runner once; disconnecting takes the offer away", async () => {
  status = async () => ({ state: "off" });
  await mount(NO_LINK);
  expect(one("calendar-link")).toBeNull();
  status = async () => CONNECTED;
  await act(async () => { for (const listener of statusListeners) listener(); });
  expect(one("calendar-link-open")).not.toBeNull();
  expect(calls).toEqual(["consider exo-voice-note rec-1"]);
  await click(one("calendar-link-open"));
  expect(one("calendar-link-picker")).not.toBeNull();
  status = async () => ({ state: "needs-reconnect" });
  await act(async () => { for (const listener of statusListeners) listener(); });
  expect(one("calendar-link")).toBeNull();
  expect(calls).toEqual(["consider exo-voice-note rec-1", "choices row-1"]);
});

test("a note with no link offers to link it, through the same picker", async () => {
  await mount(NO_LINK);
  expect(one("calendar-link-chip")).toBeNull();
  expect(one("calendar-link-open")!.textContent).toBe("Link to a calendar event…");
  await click(one("calendar-link-open"));
  await click(all("calendar-link-choice")[0]);
  expect(picks).toEqual([{ note: REF, eventId: "ev-weekly" }]);
});

test("opening a linked note reads its event again once, however often its row is read", async () => {
  await mount(linked());
  await mount(linked({ title: "Weekly sync (moved)" }));
  await mount(linked());
  expect(calls).toEqual(["refresh row-1"]);
});

test("opening a note with no link asks the runner to link it once, and the link that lands is not read again", async () => {
  await mount(null);
  expect(calls).toEqual([]);
  await mount(NO_LINK);
  await mount({ ...NO_LINK });
  await mount(linked());
  expect(calls).toEqual(["consider exo-voice-note rec-1"]);
  expect(one("calendar-link-chip")!.textContent).toContain("Weekly sync");
});

test("a pasted transcript and a note only on this phone are never linked or shown as linked", async () => {
  await mount({ ...linked(), capture: "pasted" }, runner(), { ...ITEM, metadata: { capture: "pasted" } });
  expect(one("calendar-link")).toBeNull();
  await mount({ capture: "pasted" }, runner(), { ...ITEM, metadata: { capture: "pasted" } });
  await mount(linked(), runner(), { ...ITEM, id: "on-phone:rec-1", onPhone: true });
  expect(one("calendar-link")).toBeNull();
  await mount(NO_LINK, runner(), { ...ITEM, id: "on-phone:rec-1", onPhone: true });
  expect(one("calendar-link")).toBeNull();
  expect(calls).toEqual([]);
});

test("the note page shows the event in its header, before the transcript", () => {
  const meeting: LibraryItem = { id: "row-2", source: "tinycloud-transcriber", sourceId: "mtg-2", title: "Weekly sync", startedAt: "2026-10-06T09:00:00.000Z", durationSecs: 1800 };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NoteDetailView item={meeting} listStatus="ready" metadata={{ status: "ok", metadata: {} }} transcript={{ status: "absent" }} audio={null}
        copyState="idle" onCopy={() => {}} onRetry={() => {}} pushed onBack={() => {}}
        calendarLink={{ link: { state: "linked", title: "Team weekly", start: WEEKLY.start, end: WEEKLY.end, eventMissing: false },
          connected: true, loadChoices: async () => null, pick: async () => false, busy: false, failed: false }} />
    </MemoryRouter>,
  );
  expect(html).toContain(`Team weekly · ${when(WEEKLY)}`);
  expect(html.indexOf('data-testid="calendar-link"')).toBeLessThan(html.indexOf('data-testid="note-transcript"'));
  expect(html.indexOf('data-testid="calendar-link"')).toBeGreaterThan(html.indexOf('data-testid="note-detail"'));
});
