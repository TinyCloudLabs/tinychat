import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  Loader2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { copyText } from "@/lib/copyText";
import {
  listMeetings,
  meetingSourceLabel,
  readTranscript,
  transcriptCopyText,
  type MeetingListItem,
  type TranscriptRead,
} from "@/lib/connectors/meetingExplorer";

interface MeetingsPageProps {
  tcw: TinyCloudWeb;
  onBack: () => void;
}

/** Matches markdown-text's copy button: the tick reverts on its own. */
const COPIED_DURATION = 1500;

/**
 * Browse the meetings this space has already synced — every connector's, in one
 * newest-first list — and read (or copy) one transcript at a time.
 *
 * Read-only by construction — every storage call goes through meetingExplorer,
 * which never issues DDL or a write. Transcripts are fetched lazily, cached for
 * the life of the page, and chained through a single promise so two fast
 * expands can never put two KV reads in flight at once (TinyCloud drops
 * concurrent responses on one space).
 *
 * Rows are keyed by their `connector_meeting.id` (a UUID), not by `sourceId`:
 * source ids are only unique WITHIN a connector, and the list now spans several.
 */
export function MeetingsPage({ tcw, onBack }: MeetingsPageProps) {
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  // Transcripts live in a ref, not state: the chained fetch reads it
  // synchronously to decide whether a meeting still needs a KV call, so a
  // render-cycle-late copy would refetch. `revision` is the render nudge that
  // publishes a completed fetch — the cache itself is the source of truth.
  const cacheRef = useRef(new Map<string, TranscriptRead>());
  const [revision, setRevision] = useState(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // One read across every browsable source (meetingExplorer's
      // EXPLORER_MEETING_SOURCES default), merged newest-first. listMeetings is
      // tolerant (a failed Result reads as "no meetings"); the catch is for the
      // transport itself, so a storage hiccup lands on the empty state rather
      // than an error page.
      const items = await listMeetings(tcw).catch(() => [] as MeetingListItem[]);
      if (cancelled) return;
      setMeetings(items);
      setPhase("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [tcw]);

  const resetCopy = useCallback(() => {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopyState("idle");
  }, []);

  // Only a SETTLED read is cached. `ok` and `absent` are durable answers — the
  // store has spoken, and re-reading would say the same thing. A `failed` read
  // is a transient miss (transport, expired session, storage hiccup) and is
  // never allowed to stick: it is refetched on the next expand, so
  // collapse-and-reopen is the retry path instead of the row being pinned on a
  // wrong "nothing here" for the life of the page.
  const needsFetch = useCallback((id: string) => {
    const entry = cacheRef.current.get(id);
    return entry === undefined || entry.status === "failed";
  }, []);

  const onToggle = useCallback(
    (meeting: MeetingListItem) => {
      // The copy affordance belongs to whichever transcript is open.
      resetCopy();
      const { id, source, sourceId } = meeting;
      const willOpen = openId !== id;
      setOpenId(willOpen ? id : null);
      if (!willOpen || !needsFetch(id)) return;

      // Drop a previous failure before retrying so the panel reads "loading"
      // rather than restating an error a fresh read may be about to clear.
      cacheRef.current.delete(id);

      const fetchOne = async () => {
        if (!needsFetch(id)) return;
        // Both halves of the identity: the transcript key is source-scoped, so
        // a Meet meeting read under the Fireflies prefix is a guaranteed miss.
        const read = await readTranscript(tcw, source, sourceId).catch(
          (): TranscriptRead => ({ status: "failed" }),
        );
        // Cache-write-only: a completion that lands after the row was closed
        // (or another row opened) is still a valid cache entry, so there is no
        // stale-result race to arbitrate.
        cacheRef.current.set(id, read);
        if (mountedRef.current) setRevision((n) => n + 1);
      };
      // Sequential by construction: each fetch waits for the previous one,
      // whether it resolved or rejected.
      chainRef.current = chainRef.current.then(fetchOne, fetchOne);
    },
    [needsFetch, openId, resetCopy, tcw],
  );

  const openRead = useMemo(() => {
    if (!openId) return undefined;
    void revision;
    return cacheRef.current.get(openId);
  }, [openId, revision]);

  // One string for both the rendered block and the clipboard, computed once per
  // open meeting so scrolling a long transcript never re-joins it.
  const openText = useMemo(
    () =>
      openRead?.status === "ok" && openRead.sentences.length > 0
        ? transcriptCopyText(openRead.sentences)
        : null,
    [openRead],
  );

  const onCopy = useCallback(async () => {
    if (!openText) return;
    const ok = await copyText(openText);
    if (!mountedRef.current) return;
    setCopyState(ok ? "copied" : "failed");
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      copyTimerRef.current = null;
      setCopyState("idle");
    }, COPIED_DURATION);
  }, [openText]);

  const count = meetings.length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            aria-label="Back to chat"
            onClick={onBack}
            className="h-11 gap-1.5 px-2 md:h-8 sm:px-3"
          >
            <ArrowLeftIcon className="size-4" />
            <span className="hidden sm:inline">Back to chat</span>
          </Button>
          <h1 className="text-base font-semibold tracking-tight">Meetings</h1>
        </div>
        <div className="flex flex-col gap-4">
          <SectionCard icon={CalendarClockIcon} title="Synced meetings">
            {phase === "loading" ? (
              <div className="flex flex-col gap-1" aria-hidden>
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-9 animate-pulse rounded-lg bg-muted/70"
                  />
                ))}
              </div>
            ) : count === 0 ? (
              // Names the cause for each way this list can be legitimately
              // empty, so nobody re-runs a sync waiting for a transcript that
              // cannot exist. No dead ends: every paragraph says what to do or
              // why there is nothing to do.
              <div className="flex flex-col gap-2 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <p>
                  No meetings yet. Connect Fireflies or Google Meet in Settings
                  and run a sync — meetings from both connectors land in this one
                  list.
                </p>
                <p>
                  Google Meet only has a transcript when the meeting host was on
                  a paid Google Workspace edition and transcription was turned on
                  for that meeting. Meetings hosted on a free or personal Google
                  account can never produce one, so those calls will not show up
                  here no matter how often you sync. Meetings where only Gemini
                  took notes won't appear either — Gemini's notes live in Google
                  Docs, which we don't request access to; turning on
                  transcription for meetings you host is what makes future calls
                  show up here.
                </p>
                <p>
                  A sync also reaches back at most 30 days, and a meeting where
                  transcription was switched on partway through arrives as a
                  partial transcript — both are expected, not errors.
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {count} meeting{count === 1 ? "" : "s"}
                </p>
                <ul className="mt-2 flex flex-col gap-0.5">
                  {meetings.map((m) => {
                    const isOpen = openId === m.id;
                    const dateLabel = formatStartedAt(m.startedAt);
                    const panelId = `transcript-${m.id}`;
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => onToggle(m)}
                          aria-expanded={isOpen}
                          aria-controls={panelId}
                          className="group flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent md:min-h-0"
                        >
                          <span className="flex-1 truncate">
                            {m.title ?? "Untitled meeting"}
                          </span>
                          {/* Which connector this row came from — the list is
                              merged, so the source has to be on the row itself.
                              Read out as part of the row's own label. */}
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {meetingSourceLabel(m.source)}
                          </span>
                          {dateLabel && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {dateLabel}
                            </span>
                          )}
                          <ChevronDownIcon
                            aria-hidden
                            className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                              isOpen ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                        {isOpen && (
                          <div id={panelId} className="px-3 pb-2">
                            {openRead === undefined ? (
                              <p className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
                                <Loader2Icon
                                  className="size-3.5 animate-spin"
                                  aria-hidden
                                />
                                Loading transcript…
                              </p>
                            ) : openRead.status === "failed" ? (
                              // The read itself did not land — say so, rather
                              // than reporting a missing transcript the store
                              // never actually answered about.
                              <p className="py-2 text-xs text-muted-foreground">
                                Couldn&apos;t load this transcript just now.
                                Close and reopen the meeting to try again.
                              </p>
                            ) : openText === null ? (
                              // The store answered, and there is nothing to
                              // read: not stored yet, or never will be. Both
                              // causes named so neither reads as a dead end.
                              <p className="py-2 text-xs text-muted-foreground">
                                No transcript stored for this meeting yet.
                                Transcripts can land a little after a call ends,
                                so the next sync often picks one up. If
                                transcription was never turned on — or the host
                                was on a free Google account — there won&apos;t
                                be one to fetch.
                              </p>
                            ) : (
                              <>
                                <div className="flex flex-wrap items-center gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void onCopy()}
                                    className="gap-1.5"
                                  >
                                    {copyState === "copied" ? (
                                      <CheckIcon className="size-4" aria-hidden />
                                    ) : (
                                      <CopyIcon className="size-4" aria-hidden />
                                    )}
                                    <span>
                                      {copyState === "copied"
                                        ? "Copied"
                                        : "Copy transcript"}
                                    </span>
                                  </Button>
                                  {copyState === "failed" && (
                                    <p
                                      role="alert"
                                      className="text-xs text-destructive"
                                    >
                                      Could not copy. Select the text and copy
                                      manually.
                                    </p>
                                  )}
                                  {/* Reliable SR confirmation of a copy — the
                                      button's own label change is not
                                      universally announced, and focus is
                                      already on it. Same pattern
                                      ConnectorsCard uses. */}
                                  <span
                                    className="sr-only"
                                    aria-live="polite"
                                    aria-atomic="true"
                                  >
                                    {copyState === "copied"
                                      ? "Transcript copied to clipboard"
                                      : ""}
                                  </span>
                                </div>
                                {/* `pre` + font-sans keeps the newlines of the
                                    copied string without turning the transcript
                                    into a code block. */}
                                <pre className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 font-sans text-sm text-foreground">
                                  {openText}
                                </pre>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function formatStartedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return d.toDateString();
  }
}
