// The TRANSCRIBER card in Settings: paste a meeting link, a notetaker bot joins through the
// TinyCloud Private Transcription API, and the speaker-attributed transcript comes back here.
//
// `TranscriberView` is the whole rendered surface and a pure function of its props (testable with
// react-dom/server, like MeetingsSection); `TranscriberSection` owns the client, the polling and
// the form state. No vault, no key: a session token and the backend URL are the only inputs.

import { useCallback, useEffect, useRef, useState, type FC, type FormEvent } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { AudioLinesIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import {
  createTranscriberClient,
  type TranscriberClient,
  type TranscriberListRow,
  type TranscriberMeeting,
  type TranscriberMeetingStatus,
  type TranscriberResult,
  type TranscriberTranscript,
} from "@/lib/transcriberApi";
import {
  listSavedTranscriberMeetingIds,
  saveTranscriberMeeting,
} from "@/lib/transcriberSave";

export const ACTIVE_STATUSES: ReadonlySet<TranscriberMeetingStatus> = new Set([
  "queued",
  "joining",
  "waiting_for_admission",
  "in_progress",
  "processing",
]);

/** How often the list is re-read while at least one meeting is still moving. */
export const POLL_INTERVAL_MS = 5000;

export type ListStatus = "idle" | "loading" | "ready" | "dark" | "unavailable" | "offline" | "signed-out";

export interface OpenTranscriptState {
  id: string;
  status: "loading" | "pending" | "ready" | "missing" | "unavailable";
  meetingStatus?: TranscriberMeetingStatus;
  transcript?: TranscriberTranscript;
}

export type SaveState = "saving" | "saved" | "error";

export interface TranscriberViewProps {
  listStatus: ListStatus;
  meetings: TranscriberListRow[];
  /** Per meeting id: whether its transcript has been copied into the user's space. */
  saved: Readonly<Record<string, SaveState>>;
  form: { url: string; botName: string; submitting: boolean; error: string | null };
  busyId: string | null;
  open: OpenTranscriptState | null;
  onUrlChange: (value: string) => void;
  onBotNameChange: (value: string) => void;
  onSubmit: () => void;
  onRefresh: () => void;
  onStop: (id: string) => void;
  onToggleTranscript: (id: string) => void;
  onRemove: (id: string) => void;
}

export function statusLabel(status: TranscriberMeetingStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "joining":
      return "Joining";
    case "waiting_for_admission":
      return "Waiting to be admitted";
    case "in_progress":
      return "In meeting";
    case "processing":
      return "Transcribing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function statusTone(status: TranscriberMeetingStatus): string {
  switch (status) {
    case "in_progress":
      return "bg-emerald-500";
    case "completed":
      return "bg-primary";
    case "failed":
      return "bg-destructive";
    case "cancelled":
      return "bg-muted-foreground";
    default:
      return "bg-amber-500";
  }
}

export function meetingTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
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

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

const inputClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

export const TranscriberView: FC<TranscriberViewProps> = ({
  listStatus,
  meetings,
  saved,
  form,
  busyId,
  open,
  onUrlChange,
  onBotNameChange,
  onSubmit,
  onRefresh,
  onStop,
  onToggleTranscript,
  onRemove,
}) => {
  const dark = listStatus === "dark";
  const canSubmit = !dark && !form.submitting && form.url.trim().length > 0;

  return (
    <SectionCard icon={AudioLinesIcon} title="Transcriber">
      <p className="text-xs text-muted-foreground">
        Paste a meeting link and a TinyCloud notetaker joins the call. When the meeting ends the
        speaker-attributed transcript is saved to your TinyCloud space and shows up in Meetings.
        Once everyone else leaves, the notetaker waits five minutes before ending automatically.
        You can end it immediately from the meeting row.
      </p>

      {dark ? (
        <p className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Transcription isn&apos;t configured on this backend yet. Set{" "}
          <code className="font-mono">TRANSCRIPTION_API_URL</code> and{" "}
          <code className="font-mono">TRANSCRIPTION_API_KEY</code> to enable it.
        </p>
      ) : (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label htmlFor="transcriber-meeting-url" className="sr-only">
            Meeting link
          </label>
          <input
            id="transcriber-meeting-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={form.url}
            disabled={form.submitting}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://meet.google.com/abc-defg-hij"
            className={inputClass}
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="transcriber-bot-name" className="sr-only">
              Bot name
            </label>
            <input
              id="transcriber-bot-name"
              autoComplete="off"
              spellCheck={false}
              value={form.botName}
              disabled={form.submitting}
              onChange={(e) => onBotNameChange(e.target.value)}
              placeholder="Bot name (optional)"
              className={`${inputClass} sm:max-w-[16rem]`}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              aria-label="Send bot to meeting"
              className="h-9 gap-1.5"
            >
              {form.submitting && <Loader2Icon className="size-4 animate-spin" />}
              <span>{form.submitting ? "Sending bot…" : "Send bot"}</span>
            </Button>
          </div>
          {form.error !== null && (
            <p role="alert" className="text-xs text-destructive">
              {form.error}
            </p>
          )}
        </form>
      )}

      {!dark && (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Meetings</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              aria-label="Refresh transcriber meetings"
              className="h-8 gap-1.5 px-2"
            >
              <RefreshCwIcon className={`size-4 ${listStatus === "loading" ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </Button>
          </div>

          {(listStatus === "idle" || listStatus === "loading") && meetings.length === 0 && (
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading…
            </p>
          )}
          {listStatus === "unavailable" && (
            <p className="mt-2 text-xs text-muted-foreground">
              The transcriber is temporarily unavailable. Nothing is lost — try again in a moment.
            </p>
          )}
          {listStatus === "offline" && (
            <p className="mt-2 text-xs text-muted-foreground">
              You appear to be offline, so this list may be incomplete.
            </p>
          )}
          {listStatus === "signed-out" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Your session expired. Sign in again to see your meetings.
            </p>
          )}
          {listStatus === "ready" && meetings.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              No meetings yet. Paste a link above to send the notetaker to one.
            </p>
          )}

          {meetings.length > 0 && (
            <ul className="mt-2 flex flex-col divide-y divide-border">
              {meetings.map((row) => (
                <li key={row.id} className="py-2">
                  {"unavailable" in row ? (
                    <UnavailableRow id={row.id} busy={busyId === row.id} onRemove={onRemove} />
                  ) : (
                    <MeetingRow
                      meeting={row}
                      saveState={saved[row.id]}
                      busy={busyId === row.id}
                      open={open !== null && open.id === row.id ? open : null}
                      onStop={onStop}
                      onToggleTranscript={onToggleTranscript}
                      onRemove={onRemove}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
};

function UnavailableRow(props: { id: string; busy: boolean; onRemove: (id: string) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{props.id}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Could not be read right now.
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.busy}
        onClick={() => props.onRemove(props.id)}
        className="h-8 px-2"
      >
        Remove
      </Button>
    </div>
  );
}

function MeetingRow(props: {
  meeting: TranscriberMeeting;
  saveState: SaveState | undefined;
  busy: boolean;
  open: OpenTranscriptState | null;
  onStop: (id: string) => void;
  onToggleTranscript: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { meeting, busy, open } = props;
  const active = ACTIVE_STATUSES.has(meeting.status);
  const stoppable = active && meeting.status !== "processing";
  const when = formatWhen(meeting.created_at);
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={meeting.meeting_url}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate text-sm font-medium hover:underline"
          >
            {meetingTitle(meeting.meeting_url)}
          </a>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                role="img"
                aria-label={statusLabel(meeting.status)}
                className={`size-1.5 rounded-full ${statusTone(meeting.status)} ${active ? "animate-pulse" : ""}`}
              />
              {statusLabel(meeting.status)}
            </span>
            {when && <span>· {when}</span>}
            {meeting.bot?.name && <span>· {meeting.bot.name}</span>}
            {props.saveState === "saved" && <span>· Saved to your space</span>}
            {props.saveState === "saving" && <span>· Saving to your space…</span>}
            {props.saveState === "error" && (
              <span className="text-destructive">· Could not save to your space</span>
            )}
          </span>
          {meeting.status === "failed" && meeting.error && (
            <span className="mt-0.5 block text-xs text-destructive">{meeting.error.message}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stoppable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => props.onStop(meeting.id)}
              aria-label="End meeting and transcribe now"
              className="h-8 gap-1.5 px-2"
            >
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              <span>{busy ? "Ending & transcribing…" : "End meeting & transcribe now"}</span>
            </Button>
          )}
          {meeting.status === "completed" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open !== null}
              onClick={() => props.onToggleTranscript(meeting.id)}
              className="h-8 px-2"
            >
              {open !== null ? "Hide" : "Transcript"}
            </Button>
          )}
          {!active && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => props.onRemove(meeting.id)}
              className="h-8 px-2 text-muted-foreground"
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      {open !== null && <TranscriptPanel open={open} />}
    </div>
  );
}

function TranscriptPanel({ open }: { open: OpenTranscriptState }) {
  const segments = open.transcript?.segments ?? [];
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/40 p-3">
      {open.status === "loading" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Opening…
        </p>
      )}
      {open.status === "pending" && (
        <p className="text-xs text-muted-foreground">
          The transcript is still being prepared
          {open.meetingStatus ? ` (${statusLabel(open.meetingStatus).toLowerCase()})` : ""}.
        </p>
      )}
      {open.status === "missing" && (
        <p className="text-xs text-muted-foreground">This meeting is no longer stored.</p>
      )}
      {open.status === "unavailable" && (
        <p className="text-xs text-muted-foreground">
          The transcript could not be read right now. Try again in a moment.
        </p>
      )}
      {open.status === "ready" && open.transcript && (
        <div className="flex flex-col gap-2">
          {(open.transcript.duration_seconds !== undefined || open.transcript.language) && (
            <p className="text-xs text-muted-foreground">
              {open.transcript.duration_seconds !== undefined &&
                `${formatClock(open.transcript.duration_seconds)} · `}
              {open.transcript.speakers?.length ?? 0} speaker
              {(open.transcript.speakers?.length ?? 0) === 1 ? "" : "s"}
              {open.transcript.language && ` · ${open.transcript.language}`}
            </p>
          )}
          {segments.length > 0 ? (
            <ol className="flex max-h-80 flex-col gap-1.5 overflow-y-auto text-xs">
              {segments.map((segment) => (
                <li key={segment.id} className="flex gap-2">
                  <span className="w-10 shrink-0 tabular-nums text-muted-foreground">
                    {formatClock(segment.start)}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium">{segment.speaker_name}: </span>
                    <span className="whitespace-pre-wrap">{segment.text}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : open.transcript.text ? (
            <p className="max-h-80 overflow-y-auto whitespace-pre-wrap text-xs">{open.transcript.text}</p>
          ) : (
            <p className="text-xs text-muted-foreground">The transcript is empty.</p>
          )}
        </div>
      )}
    </div>
  );
}

export interface TranscriberSectionProps {
  backendUrl: string;
  sessionStore: SessionStore;
  /**
   * The user's session client. When present, a completed meeting's transcript is copied into
   * the user's own space (connector_meeting row + KV body, like Fireflies) as soon as it is seen.
   */
  tcw?: TinyCloudWeb;
  /** Injectable for tests; defaults to the real client. */
  client?: TranscriberClient;
  /** Injectable for tests; defaults to the real store writers. */
  saver?: {
    listSaved: (tcw: TinyCloudWeb) => Promise<{ ok: boolean; data?: string[] }>;
    save: (
      tcw: TinyCloudWeb,
      meeting: TranscriberMeeting,
      transcript: TranscriberTranscript,
    ) => Promise<{ ok: boolean }>;
  };
}

function listStatusOf<T>(result: TranscriberResult<T>): ListStatus {
  switch (result.status) {
    case "ok":
      return "ready";
    case "feature-dark":
      return "dark";
    case "unauthenticated":
      return "signed-out";
    case "offline":
      return "offline";
    default:
      return "unavailable";
  }
}

export function describeFailure<T>(result: TranscriberResult<T>): string {
  switch (result.status) {
    case "unauthenticated":
      return "Your session expired. Sign in again.";
    case "offline":
      return "You appear to be offline.";
    case "feature-dark":
      return "Transcription isn't configured on this backend.";
    case "not-found":
      return "That meeting is no longer stored.";
    case "retryable":
      return "The transcriber is temporarily unavailable. Try again in a moment.";
    case "rejected":
      switch (result.code) {
        case "invalid_meeting_url":
          return "That doesn't look like a meeting link.";
        case "unsupported_platform":
          return "That meeting platform isn't supported yet.";
        default:
          return result.message ?? "The transcriber refused that request.";
      }
    case "ok":
      return "";
  }
}

export const TranscriberSection: FC<TranscriberSectionProps> = ({
  backendUrl,
  sessionStore,
  tcw,
  client,
  saver,
}) => {
  const apiRef = useRef<TranscriberClient | null>(null);
  if (apiRef.current === null) {
    apiRef.current = client ?? createTranscriberClient(backendUrl, { sessionStore });
  }
  const api = apiRef.current;
  const saverRef = useRef(
    saver ?? { listSaved: listSavedTranscriberMeetingIds, save: saveTranscriberMeeting },
  );

  const [listStatus, setListStatus] = useState<ListStatus>("idle");
  const [meetings, setMeetings] = useState<TranscriberListRow[]>([]);
  const [url, setUrl] = useState("");
  const [botName, setBotName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenTranscriptState | null>(null);
  const [saved, setSaved] = useState<Record<string, SaveState>>({});
  const savedSeeded = useRef(false);

  const load = useCallback(async () => {
    setListStatus((s) => (s === "ready" ? s : "loading"));
    // A failed save gets another go on every explicit or polled refresh.
    setSaved((current) => {
      const next: Record<string, SaveState> = {};
      for (const [id, state] of Object.entries(current)) if (state !== "error") next[id] = state;
      return next;
    });
    const result = await api.list();
    setListStatus(listStatusOf(result));
    if (result.status === "ok") setMeetings(result.value.meetings);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is still moving; a settled list costs nothing.
  const anyActive = meetings.some((m) => !("unavailable" in m) && ACTIVE_STATUSES.has(m.status));
  useEffect(() => {
    if (!anyActive || listStatus === "dark") return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [anyActive, listStatus, load]);

  // Seed "already saved" from the user's space once, so a reload does not re-copy meetings.
  useEffect(() => {
    if (!tcw || savedSeeded.current) return;
    savedSeeded.current = true;
    void (async () => {
      const result = await saverRef.current.listSaved(tcw);
      if (!result.ok || !result.data) return;
      setSaved((current) => {
        const next = { ...current };
        for (const id of result.data ?? []) if (next[id] === undefined) next[id] = "saved";
        return next;
      });
    })();
  }, [tcw]);

  // Copy every COMPLETED meeting into the user's space exactly once. Transcript fetch + upsert;
  // a failure is shown on the row and retried when the user hits Refresh (`load` clears errors).
  useEffect(() => {
    if (!tcw) return;
    const pending = meetings.filter(
      (m): m is TranscriberMeeting =>
        !("unavailable" in m) && m.status === "completed" && saved[m.id] === undefined,
    );
    if (pending.length === 0) return;
    setSaved((current) => {
      const next = { ...current };
      for (const m of pending) next[m.id] = "saving";
      return next;
    });
    void (async () => {
      for (const m of pending) {
        const result = await api.transcript(m.id);
        let ok = false;
        if (result.status === "ok" && result.value.status === "ready") {
          ok = (await saverRef.current.save(tcw, m, result.value.transcript)).ok;
        }
        setSaved((current) => ({ ...current, [m.id]: ok ? "saved" : "error" }));
      }
    })();
  }, [api, meetings, saved, tcw]);

  const onSubmit = useCallback(() => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    setFormError(null);
    void (async () => {
      const result = await api.create({
        meeting_url: trimmed,
        ...(botName.trim() ? { bot_name: botName.trim() } : {}),
      });
      setSubmitting(false);
      if (result.status !== "ok") {
        setFormError(describeFailure(result));
        return;
      }
      setUrl("");
      setMeetings((current) => [result.value, ...current.filter((m) => m.id !== result.value.id)]);
      setListStatus("ready");
    })();
  }, [api, botName, submitting, url]);

  const onStop = useCallback(
    (id: string) => {
      setBusyId(id);
      void (async () => {
        const result = await api.stop(id);
        setBusyId(null);
        if (result.status === "ok") {
          setMeetings((current) =>
            current.map((m) => (m.id === id && !("unavailable" in m) ? { ...m, status: result.value.status } : m)),
          );
        }
        void load();
      })();
    },
    [api, load],
  );

  const onRemove = useCallback(
    (id: string) => {
      setBusyId(id);
      void (async () => {
        const result = await api.remove(id);
        setBusyId(null);
        if (result.status === "ok" || result.status === "not-found") {
          setMeetings((current) => current.filter((m) => m.id !== id));
          setOpen((o) => (o !== null && o.id === id ? null : o));
        }
      })();
    },
    [api],
  );

  const onToggleTranscript = useCallback(
    (id: string) => {
      if (open !== null && open.id === id) {
        setOpen(null);
        return;
      }
      setOpen({ id, status: "loading" });
      void (async () => {
        const result = await api.transcript(id);
        if (result.status === "ok") {
          setOpen(
            result.value.status === "ready"
              ? { id, status: "ready", transcript: result.value.transcript }
              : { id, status: "pending", meetingStatus: result.value.meetingStatus },
          );
          return;
        }
        setOpen({ id, status: result.status === "not-found" ? "missing" : "unavailable" });
      })();
    },
    [api, open],
  );

  return (
    <TranscriberView
      listStatus={listStatus}
      meetings={meetings}
      saved={saved}
      form={{ url, botName, submitting, error: formError }}
      busyId={busyId}
      open={open}
      onUrlChange={setUrl}
      onBotNameChange={setBotName}
      onSubmit={onSubmit}
      onRefresh={() => void load()}
      onStop={onStop}
      onToggleTranscript={onToggleTranscript}
      onRemove={onRemove}
    />
  );
};
