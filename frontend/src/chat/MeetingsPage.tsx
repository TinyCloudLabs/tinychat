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
  readTranscriptSentences,
  transcriptCopyText,
  type MeetingListItem,
} from "@/lib/connectors/meetingExplorer";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";

interface MeetingsPageProps {
  tcw: TinyCloudWeb;
  onBack: () => void;
}

/** Matches markdown-text's copy button: the tick reverts on its own. */
const COPIED_DURATION = 1500;

/**
 * Browse the meetings this space has already synced, and read (or copy) one
 * transcript at a time.
 *
 * Read-only by construction — every storage call goes through meetingExplorer,
 * which never issues DDL or a write. Transcripts are fetched lazily, cached for
 * the life of the page, and chained through a single promise so two fast
 * expands can never put two KV reads in flight at once (TinyCloud drops
 * concurrent responses on one space).
 */
export function MeetingsPage({ tcw, onBack }: MeetingsPageProps) {
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  // Transcripts live in a ref, not state: the chained fetch reads it
  // synchronously to decide whether a meeting still needs a KV call, so a
  // render-cycle-late copy would refetch. `revision` is the render nudge that
  // publishes a completed fetch — the cache itself is the source of truth.
  const cacheRef = useRef(new Map<string, FirefliesSentence[] | null>());
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
      // listMeetings is tolerant (a failed Result reads as "no meetings"); the
      // catch is for the transport itself, so a storage hiccup lands on the
      // empty state rather than an error page.
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

  // A cached `null` is not a durable answer: "no transcript stored" and "that
  // read failed" are indistinguishable here, so only sentences settle the
  // question. Anything else is refetched, which makes collapse-and-reopen the
  // retry path for a transient failure instead of pinning the row on
  // "not synced yet" for the life of the page.
  const needsFetch = useCallback(
    (sourceId: string) => !cacheRef.current.get(sourceId),
    [],
  );

  const onToggle = useCallback(
    (sourceId: string) => {
      // The copy affordance belongs to whichever transcript is open.
      resetCopy();
      const willOpen = openSourceId !== sourceId;
      setOpenSourceId(willOpen ? sourceId : null);
      if (!willOpen || !needsFetch(sourceId)) return;

      const fetchOne = async () => {
        if (!needsFetch(sourceId)) return;
        const sentences = await readTranscriptSentences(tcw, sourceId).catch(
          () => null,
        );
        // Cache-write-only: a completion that lands after the row was closed
        // (or another row opened) is still a valid cache entry, so there is no
        // stale-result race to arbitrate.
        cacheRef.current.set(sourceId, sentences);
        if (mountedRef.current) setRevision((n) => n + 1);
      };
      // Sequential by construction: each fetch waits for the previous one,
      // whether it resolved or rejected.
      chainRef.current = chainRef.current.then(fetchOne, fetchOne);
    },
    [needsFetch, openSourceId, resetCopy, tcw],
  );

  const openSentences = useMemo(() => {
    if (!openSourceId) return undefined;
    void revision;
    return cacheRef.current.get(openSourceId);
  }, [openSourceId, revision]);

  // One string for both the rendered block and the clipboard, computed once per
  // open meeting so scrolling a long transcript never re-joins it.
  const openText = useMemo(
    () =>
      openSentences && openSentences.length > 0
        ? transcriptCopyText(openSentences)
        : null,
    [openSentences],
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
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No meetings yet. Connect Fireflies in Settings to sync meeting
                transcripts.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {count} meeting{count === 1 ? "" : "s"}
                </p>
                <ul className="mt-2 flex flex-col gap-0.5">
                  {meetings.map((m) => {
                    const isOpen = openSourceId === m.sourceId;
                    const dateLabel = formatStartedAt(m.startedAt);
                    const panelId = `transcript-${m.sourceId}`;
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => onToggle(m.sourceId)}
                          aria-expanded={isOpen}
                          aria-controls={panelId}
                          className="group flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent md:min-h-0"
                        >
                          <span className="flex-1 truncate">
                            {m.title ?? "Untitled meeting"}
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
                            {!cacheRef.current.has(m.sourceId) ? (
                              <p className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
                                <Loader2Icon
                                  className="size-3.5 animate-spin"
                                  aria-hidden
                                />
                                Loading transcript…
                              </p>
                            ) : openText === null ? (
                              // Null payload or an empty sentence list: either
                              // way there is nothing to read or copy yet. A
                              // failed read looks the same, so point at the
                              // retry rather than claiming it will never load.
                              <p className="py-2 text-xs text-muted-foreground">
                                Transcript not synced yet. Close and reopen this
                                meeting to check again.
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
