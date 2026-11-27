// The calendar event a note belongs to, under the note's meta line: the linked event with Change… and Unlink, the
// question when more than one event fits, and the picker both open. It only asks the controller (useCalendarLink);
// nothing here writes the transcript, the title or a speaker name.
import { useId, useRef, useState } from "react";
import { CalendarIcon, Loader2Icon } from "lucide-react";
import type { CalendarLinkCandidate } from "@tinyboilerplate/core";

import { Button } from "@/components/ui/button";
import { shortDate, timeOfDay } from "./formatters";
import type { CalendarLinkController } from "./useCalendarLink";

export const CALENDAR_LINK_COPY = {
  untitled: "Calendar event",
  change: "Change…",
  unlink: "Unlink",
  missing: "No longer on your calendar",
  question: "Which meeting was this?",
  noneOfThese: "None of these",
  link: "Link to a calendar event…",
  loading: "Loading your calendar…",
  unreadable: "Your calendar can’t be read right now.",
  empty: "No meetings around this time.",
  cancel: "Cancel",
  saving: "Saving…",
  failed: "Couldn’t save. Try again.",
  options: (event: string) => `Calendar event: ${event}. Options`,
} as const;

function instant(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Tue, Oct 6, 9:00 AM–9:30 AM" in the viewer's time zone; null when the start is not a time. */
export function calendarEventWhen(start: string | null, end: string | null, now: Date): string | null {
  const from = instant(start);
  if (from === null) return null;
  const to = instant(end);
  const day = `${from.toLocaleDateString(undefined, { weekday: "short" })}, ${shortDate(from, now)}`;
  return to === null ? `${day}, ${timeOfDay(from)}` : `${day}, ${timeOfDay(from)}–${timeOfDay(to)}`;
}

/** "Weekly sync · Tue, Oct 6, 9:00 AM–9:30 AM"; an event without a title is "Calendar event". */
export function calendarEventLabel(event: { title: string; start: string | null; end: string | null }, now: Date): string {
  const when = calendarEventWhen(event.start, event.end, now);
  const title = event.title.trim() || CALENDAR_LINK_COPY.untitled;
  return when === null ? title : `${title} · ${when}`;
}

const MENU_ITEM = "block min-h-11 w-full rounded-sm px-3 py-2 text-left text-meta hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const CHOICE = "h-auto min-h-[var(--tc-control-height-sm)] max-w-full whitespace-normal py-1 text-left";

/** The events to pick from as buttons, then "None of these". */
function Choices(props: { events: readonly CalendarLinkCandidate[]; disabled: boolean; onPick: (eventId: string | null) => void }) {
  const now = new Date();
  return (
    <>
      {props.events.map((event) => (
        <Button key={event.event_id} type="button" variant="outline" size="sm" className={CHOICE} disabled={props.disabled}
          data-testid="calendar-link-choice" onClick={() => props.onPick(event.event_id)}>
          {calendarEventLabel(event, now)}
        </Button>
      ))}
      <Button type="button" variant="ghost" size="sm" disabled={props.disabled} data-testid="calendar-link-none" onClick={() => props.onPick(null)}>
        {CALENDAR_LINK_COPY.noneOfThese}
      </Button>
    </>
  );
}

type Picker = { status: "loading" } | { status: "unreadable" } | { status: "ready"; choices: readonly CalendarLinkCandidate[] };

/**
 * One line under the note's meta line for a note that can be linked: the linked event, or "Link to a calendar
 * event…" where there is none, so a link that lands while the note is open takes the line that was already there.
 * With the calendar not connected only a stored link shows, with Unlink alone: nothing is asked or offered that
 * would need the calendar. Nothing without a controller.
 */
export function CalendarLinkChip({ calendarLink }: { calendarLink: CalendarLinkController | undefined }) {
  const [picker, setPicker] = useState<Picker | null>(null);
  const request = useRef(0);
  const questionId = useId();
  if (calendarLink === undefined) return null;
  const { link, busy, connected } = calendarLink;
  if (!connected && link.state !== "linked") return null;

  const openPicker = () => {
    const mine = ++request.current;
    setPicker({ status: "loading" });
    void calendarLink.loadChoices().then((choices) => {
      if (request.current === mine) setPicker(choices === null ? { status: "unreadable" } : { status: "ready", choices });
    });
  };
  const closePicker = () => {
    request.current++;
    setPicker(null);
  };
  // A pick that was not saved leaves what is shown, with the failure under it.
  const pick = (eventId: string | null) => { void calendarLink.pick(eventId).then((saved) => { if (saved) closePicker(); }); };
  const label = link.state === "linked" ? calendarEventLabel(link, new Date()) : null;

  return (
    <div className="flex flex-col gap-1" data-testid="calendar-link" data-state={link.state}>
      {link.state === "ambiguous" ? (
        <div role="group" aria-labelledby={questionId} className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1" data-testid="calendar-link-question">
          <p id={questionId} className="text-meta text-muted-foreground">{CALENDAR_LINK_COPY.question}</p>
          <Choices events={link.candidates} disabled={busy} onPick={pick} />
        </div>
      ) : (
        <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3">
          {label !== null ? (
            <>
              <details className="relative min-w-0 max-w-full">
                <summary aria-label={CALENDAR_LINK_COPY.options(label)} data-testid="calendar-link-chip"
                  className="-mx-2 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-meta text-muted-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <CalendarIcon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{label}</span>
                  <span aria-hidden>▾</span>
                </summary>
                <div className="absolute left-0 z-10 min-w-40 rounded-md border bg-popover p-1 shadow-sm">
                  {connected && <button type="button" className={MENU_ITEM} data-testid="calendar-link-change"
                    onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openPicker(); }}>{CALENDAR_LINK_COPY.change}</button>}
                  <button type="button" className={MENU_ITEM} data-testid="calendar-link-unlink" disabled={busy}
                    onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); closePicker(); pick(null); }}>{CALENDAR_LINK_COPY.unlink}</button>
                </div>
              </details>
              {link.state === "linked" && link.eventMissing && <p className="text-meta text-muted-foreground" data-testid="calendar-link-missing">{CALENDAR_LINK_COPY.missing}</p>}
            </>
          ) : picker === null && (
            <button type="button" data-testid="calendar-link-open" onClick={openPicker}
              className="min-h-11 rounded-md text-meta text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {CALENDAR_LINK_COPY.link}
            </button>
          )}
        </div>
      )}
      {picker !== null && connected && (
        <div role="group" aria-label={CALENDAR_LINK_COPY.question} className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1" data-testid="calendar-link-picker" data-state={picker.status}>
          {picker.status === "loading" ? (
            <p role="status" className="flex items-center gap-2 text-meta text-muted-foreground">
              <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> {CALENDAR_LINK_COPY.loading}
            </p>
          ) : picker.status === "unreadable" ? (
            <p role="status" className="text-meta text-muted-foreground">{CALENDAR_LINK_COPY.unreadable}</p>
          ) : (
            <>
              {picker.choices.length === 0 && <p role="status" className="text-meta text-muted-foreground">{CALENDAR_LINK_COPY.empty}</p>}
              <Choices events={picker.choices} disabled={busy} onPick={pick} />
            </>
          )}
          <Button type="button" variant="ghost" size="sm" data-testid="calendar-link-cancel" onClick={closePicker}>{CALENDAR_LINK_COPY.cancel}</Button>
        </div>
      )}
      {busy && <p role="status" className="text-meta text-muted-foreground">{CALENDAR_LINK_COPY.saving}</p>}
      {calendarLink.failed && !busy && <p role="alert" className="text-meta text-destructive" data-testid="calendar-link-failed">{CALENDAR_LINK_COPY.failed}</p>}
    </div>
  );
}
