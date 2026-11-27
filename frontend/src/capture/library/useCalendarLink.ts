import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CALENDAR_LINK_KEY, calendarLinkState, parseCalendarLink, type CalendarLinkCandidate } from "@tinyboilerplate/core";
import { calendarLinkingEnabled } from "@/lib/calendarLink/calendarLinkFeature";
import type { CalendarLinkNoteRef, CalendarLinkRunner } from "@/lib/calendarLink/linkRunner";
import { onCalendarLinkStatus, readCalendarLinkStatus } from "@/lib/connectors/googleCalendarLink";

/** What the note's row says about its calendar event. `unlinked`: the row has no `calendar_link`. `none`: the user chose no event. */
export type CalendarLinkView =
  | { state: "linked"; title: string; start: string | null; end: string | null; eventMissing: boolean }
  | { state: "ambiguous"; candidates: readonly CalendarLinkCandidate[] }
  | { state: "none" }
  | { state: "unlinked" };

export interface CalendarLinkController {
  link: CalendarLinkView;
  /** The calendar is connected now. False until that is known: a stored link still shows, nothing new is read or offered. */
  connected: boolean;
  /** "Change…": the events around the note's time; null when the calendar cannot be read now. */
  loadChoices: () => Promise<CalendarLinkCandidate[] | null>;
  /** The user's pick: an event, or null for "None of these" / "Unlink". False when it was not saved. */
  pick: (eventId: string | null) => Promise<boolean>;
  /** A pick is being saved. */
  busy: boolean;
  /** The last pick was not saved. */
  failed: boolean;
}

const UNLINKED: CalendarLinkView = { state: "unlinked" };

function linkView(metadata: Record<string, unknown>): CalendarLinkView {
  const link = parseCalendarLink(metadata[CALENDAR_LINK_KEY]);
  if (link === null) return UNLINKED;
  const state = calendarLinkState(link);
  if (state === "linked") return { state, title: link.title ?? "", start: link.start ?? null, end: link.end ?? null, eventMissing: link.event_missing === true };
  return state === "ambiguous" ? { state, candidates: link.candidates } : { state };
}

/**
 * The open note's calendar event. With the calendar connected, opening a linked note asks the runner to read its
 * event again and opening one with no link asks the runner to link it (both once per note, and the runner decides
 * whether anything is due); not connected, the runner is asked for neither. A pick goes through the runner and
 * nowhere else: the transcript, the title and the speaker names are never touched here.
 * Undefined when calendar linking is off in this build, there is no runner, the note is not a row in the space,
 * it is a pasted transcript, or its metadata is not read.
 */
export function useCalendarLink(options: {
  tcw: TinyCloudWeb;
  runner: CalendarLinkRunner | undefined;
  /** The note's row; null unless it is in the space. */
  row: { id: string; source: string; sourceId: string; onPhone?: true } | null;
  /** The row's metadata; null until it is read. */
  metadata: Record<string, unknown> | null;
}): CalendarLinkController | undefined {
  const { tcw, metadata } = options;
  const runner = calendarLinkingEnabled() ? options.runner : undefined;
  const row = options.row !== null && options.row.onPhone !== true && metadata !== null && metadata.capture !== "pasted" ? options.row : null;
  const [id, source, sourceId] = [row?.id ?? null, row?.source ?? null, row?.sourceId ?? null];
  // The row's item object changes with every list read; the ref changes only with the note.
  const ref = useMemo<CalendarLinkNoteRef | null>(
    () => id !== null && source !== null && sourceId !== null ? { id, source, sourceId } : null,
    [id, source, sourceId],
  );
  const link = useMemo(() => metadata === null ? UNLINKED : linkView(metadata), [metadata]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Whether the calendar is connected, read again whenever this session connects, disconnects or loses its grant.
  const eligible = runner !== undefined && ref !== null;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!eligible) return;
    let live = true;
    let latest = 0;
    const read = () => {
      const mine = ++latest;
      void readCalendarLinkStatus(tcw).then((status) => status.state === "connected", () => false)
        .then((now) => { if (live && mine === latest) setConnected(now); });
    };
    read();
    const stop = onCalendarLinkStatus(read);
    return () => { live = false; stop(); setConnected(false); };
  }, [tcw, eligible]);

  // Once per opened note: a link the runner or the user writes while the note is open asks for nothing more.
  const opened = useRef<string | null>(null);
  const state = link.state;
  useEffect(() => {
    if (runner === undefined || ref === null || !connected || opened.current === ref.id) return;
    opened.current = ref.id;
    if (state === "linked") runner.refresh(ref);
    else if (state === "unlinked") runner.consider(ref.source, ref.sourceId);
  }, [runner, ref, state, connected]);

  const loadChoices = useCallback(async () => {
    if (runner === undefined || ref === null) return null;
    try {
      return await runner.choices(ref);
    } catch {
      return null;
    }
  }, [runner, ref]);
  const pick = useCallback(async (eventId: string | null) => {
    if (runner === undefined || ref === null) return false;
    setBusy(true);
    setFailed(false);
    const saved = await runner.pick(ref, eventId).catch(() => false);
    if (mounted.current) {
      setBusy(false);
      setFailed(!saved);
    }
    return saved;
  }, [runner, ref]);

  return useMemo(
    () => runner === undefined || ref === null ? undefined : { link, connected, loadChoices, pick, busy, failed },
    [runner, ref, link, connected, loadChoices, pick, busy, failed],
  );
}
