// The COHORT MEETINGS VIEW (backend-ingest plan §8.1 W5).
//
// This is the surface the whole backend-ingest reversal exists for. Under the
// shipped Option C a meeting only ever exists where the browser put it, so a
// phone that has never opened the app sees nothing. For an address enrolled in
// the dark cohort the backend already holds the meeting, and this section reads
// it back over the authenticated read API — on ANY signed-in device, with no
// vault, no Fireflies key and no wallet prompt. Sign-in is still required, and
// that is expected (plan §12.1): "always there" means the meeting is, not that
// the app is open.
//
// The read API is CANONICAL here. The user-space copy (W6) is merged in by
// `(source, sourceId)` for Option-C parity and offline, so a meeting that has
// been reconciled into the user's own space renders exactly ONCE.
//
// The whole surface is a pure function of `meetingsView.ts`'s state, kept in
// `MeetingsView` so it is testable without a DOM; `MeetingsSection` owns the
// client and the effects. When the feature is dark for this address the section
// renders NOTHING — a non-cohort user must not learn it exists.

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { CalendarClockIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  createConnectorMeetingsClient,
  type ConnectorMeetingContent,
  type ConnectorMeetingsClient,
} from "@/lib/connectors/meetingsApi";
import {
  DEFAULT_MEETINGS_SOURCE,
  applyListResult,
  initialMeetingsViewState,
  summaryText,
  transcriptText,
  type MergedMeeting,
  type MeetingsViewState,
} from "@/lib/connectors/meetingsView";

/** One opened meeting. `missing` is its own state: retention or a purge took it. */
export interface OpenMeetingState {
  sourceId: string;
  status: "loading" | "ready" | "missing" | "unavailable";
  content?: ConnectorMeetingContent;
}

export interface MeetingsViewProps {
  state: MeetingsViewState;
  connectorName: string;
  open: OpenMeetingState | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  onOpen: (meeting: MergedMeeting) => void;
  onClose: () => void;
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "Date unknown";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Date unknown";
  try {
    return parsed.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return parsed.toDateString();
  }
}

/** What the user sees, in each state. A pure function of the state — no effects. */
export const MeetingsView: FC<MeetingsViewProps> = ({
  state,
  connectorName,
  open,
  onRefresh,
  onLoadMore,
  onOpen,
  onClose,
}) => {
  // Dark = the flag is off or this address is not in the cohort. Render nothing:
  // the surface must be invisible, not merely empty.
  if (state.status === "dark") return null;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarClockIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">Meetings</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          aria-label="Refresh meetings"
          className="h-8 gap-1.5 px-2"
        >
          <RefreshCwIcon
            className={`size-4 ${state.status === "loading" ? "animate-spin" : ""}`}
          />
          <span>Refresh</span>
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {connectorName} meetings this account has stored for you. They are here on
        any device you sign in to — you do not need the device that set the
        connector up.
      </p>

      <div className="mt-3">
        {state.status === "loading" && state.meetings.length === 0 && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading your meetings…
          </p>
        )}

        {/* Every failure is TOLD. None of them renders as an empty archive: the
            backend answers 503 rather than an empty list for exactly this reason. */}
        {state.status === "unavailable" && (
          <Notice
            tone="warn"
            text="Your meetings are temporarily unavailable. Nothing is lost — this is a problem reading them, not a problem with the meetings."
            actionLabel="Try again"
            onAction={onRefresh}
          />
        )}
        {state.status === "offline" && (
          <Notice
            tone="warn"
            text="You appear to be offline, so this list may be incomplete."
            actionLabel="Try again"
            onAction={onRefresh}
          />
        )}
        {state.status === "signed-out" && (
          <Notice
            tone="warn"
            text="Your session expired. Sign in again to see your meetings."
          />
        )}

        {state.status === "ready" && state.meetings.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No meetings stored yet. New ones appear here on their own — you do not
            have to open the app for them to arrive.
          </p>
        )}

        {state.meetings.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {state.meetings.map((meeting) => (
              <li key={`${meeting.source} ${meeting.sourceId}`} className="py-2">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onOpen(meeting)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm font-medium">
                      {meeting.title ?? "Untitled meeting"}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {formatWhen(meeting.ts)}
                      {meeting.hasSummary && !meeting.hasTranscript && (
                        <span className="ml-2">· Summary only</span>
                      )}
                      {meeting.origin === "local" && (
                        <span className="ml-2">· On this device</span>
                      )}
                      {meeting.reconciled && (
                        <span className="ml-2">· Saved to your space</span>
                      )}
                    </span>
                  </button>
                </div>
                {open !== null && open.sourceId === meeting.sourceId && (
                  <OpenMeeting open={open} onClose={onClose} />
                )}
              </li>
            ))}
          </ul>
        )}

        {state.hasMore && (
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" onClick={onLoadMore}>
              Load more
            </Button>
          </div>
        )}
      </div>
    </section>
  );
};

function OpenMeeting(props: { open: OpenMeetingState; onClose: () => void }) {
  const { open } = props;
  const summary =
    open.content === undefined ? null : summaryText(open.content.content);
  const transcript =
    open.content === undefined ? null : transcriptText(open.content.content);
  // An unrecognized provider shape still shows the meeting: a tidy renderer is
  // worth less than the content the user came for.
  const raw =
    open.content === undefined || summary !== null || transcript !== null
      ? null
      : JSON.stringify(open.content.content, null, 2).slice(0, 4000);

  return (
    <div className="mt-2 rounded-md border border-border bg-muted/40 p-3">
      {open.status === "loading" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Opening…
        </p>
      )}
      {open.status === "missing" && (
        <p className="text-xs text-muted-foreground">
          This meeting is no longer stored on the server.
        </p>
      )}
      {open.status === "unavailable" && (
        <p className="text-xs text-muted-foreground">
          This meeting could not be read right now. Try again in a moment.
        </p>
      )}
      {open.status === "ready" && (
        <div className="flex flex-col gap-2">
          {summary !== null && (
            <p className="whitespace-pre-wrap text-xs">{summary}</p>
          )}
          {transcript !== null && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Transcript
              </summary>
              <p className="mt-1 whitespace-pre-wrap text-xs">{transcript}</p>
            </details>
          )}
          {raw !== null && (
            <pre className="overflow-x-auto text-[11px] text-muted-foreground">
              {raw}
            </pre>
          )}
        </div>
      )}
      <div className="mt-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function Notice(props: {
  tone: "warn";
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{props.text}</p>
      {props.actionLabel !== undefined && props.onAction !== undefined && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={props.onAction}>
            {props.actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export interface MeetingsSectionProps {
  /** Passed down from App — the section constructs no globals of its own. */
  backendUrl: string;
  sessionStore: SessionStore;
  source?: string;
  connectorName?: string;
  /** Injectable for tests and for a future W6 hand-off; defaults to the real client. */
  client?: ConnectorMeetingsClient;
}

/**
 * The stateful wrapper: one client, one read on mount, explicit paging. It holds
 * no key material and no storage handle — a session token is the whole
 * requirement, which is the point of the read API.
 */
export const MeetingsSection: FC<MeetingsSectionProps> = ({
  backendUrl,
  sessionStore,
  source = DEFAULT_MEETINGS_SOURCE,
  connectorName = "Fireflies",
  client,
}) => {
  const [state, setState] = useState<MeetingsViewState>(() =>
    initialMeetingsViewState(source),
  );
  const [open, setOpen] = useState<OpenMeetingState | null>(null);

  const apiRef = useRef<ConnectorMeetingsClient | null>(null);
  if (apiRef.current === null) {
    apiRef.current =
      client ?? createConnectorMeetingsClient(backendUrl, { sessionStore });
  }
  const api = apiRef.current;

  const loadPage = useCallback(
    async (cursor?: string) => {
      const result = await api.list(
        cursor === undefined ? { source } : { source, cursor },
      );
      // Every result is folded, including the failures: a resolved non-`ok` is a
      // state the user is told about, never a silently empty list.
      setState((current) => applyListResult(current, result));
    },
    [api, source],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await api.list({ source });
      if (!live) return;
      setState((current) => applyListResult(current, result));
    })();
    return () => {
      live = false;
    };
  }, [api, source]);

  const onRefresh = useCallback(() => {
    setOpen(null);
    setState(initialMeetingsViewState(source));
    void loadPage();
  }, [loadPage, source]);

  const onLoadMore = useCallback(() => {
    const cursor = state.nextCursor;
    if (cursor === null) return;
    void loadPage(cursor);
  }, [loadPage, state.nextCursor]);

  const onOpen = useCallback(
    (meeting: MergedMeeting) => {
      if (open !== null && open.sourceId === meeting.sourceId) {
        setOpen(null);
        return;
      }
      setOpen({ sourceId: meeting.sourceId, status: "loading" });
      void (async () => {
        const result = await api.read(meeting.source, meeting.sourceId);
        setOpen(
          result.status === "ok"
            ? { sourceId: meeting.sourceId, status: "ready", content: result.value }
            : {
                sourceId: meeting.sourceId,
                status: result.status === "not-found" ? "missing" : "unavailable",
              },
        );
      })();
    },
    [api, open],
  );

  const onClose = useCallback(() => setOpen(null), []);

  return (
    <MeetingsView
      state={state}
      connectorName={connectorName}
      open={open}
      onRefresh={onRefresh}
      onLoadMore={onLoadMore}
      onOpen={onOpen}
      onClose={onClose}
    />
  );
};
