// The meeting notetaker on Capture (TC-761): paste a meeting link, a TinyCloud
// notetaker joins through the TinyCloud Private Transcription API, and the
// speaker-attributed transcript comes back and is saved to the user's space
// (TranscriberLibrarySyncProvider, at App level).
//
// `TranscriberView` is the Meeting sheet's body and a pure function of its
// props (testable with react-dom/server, like MeetingsSection);
// `useMeetingBot` owns the client, the polling and the form state. Capture
// calls it once and hands it to the sheet and to the In progress rows. No
// vault, no key: a session token and the backend URL are the only inputs.

import { useCallback, useEffect, useMemo, useRef, useState, type FC, type FormEvent } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { meetingLinkFromInput } from "@tinyboilerplate/core";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";

import { RouteLine } from "@/capture/recorder/RouteLine";
import { NOTETAKER_ROUTE } from "@/capture/sheetRoute";
import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import {
  createTranscriberClient,
  type TranscriberClient,
  type TranscriberListRow,
  type TranscriberMeeting,
  type TranscriberMeetingStatus,
  type TranscriberResult,
  type TranscriberTranscript,
} from "@/lib/transcriberApi";
import { useTranscriberSavedState } from "./useTranscriberLibrarySync";
import { createCalendarAutojoinClient, calendarOutcomeLabel, type CalendarAutojoinOutcome } from "@/lib/connectors/calendarAutojoinApi";
import { transcriberMeetingTitle } from "@/lib/transcriberSave";
import { useLocalNode } from "./LocalNodeNotice";

export const ACTIVE_STATUSES: ReadonlySet<TranscriberMeetingStatus> = new Set([
  "queued",
  "joining",
  "waiting_for_admission",
  "in_progress",
  "processing",
]);

/** How often the list is re-read while at least one meeting is still moving. */
export const POLL_INTERVAL_MS = 5000;

/** How often calendar autojoin outcomes are re-read while the notetaker is on screen. */
export const CALENDAR_INTERVAL_MS = 60_000;
const SEND_INTENT_PREFIX = "tinychat.notetaker.send.v2:";
const SEND_KEY_RE = /^manual-v1-[0-9a-f-]{36}$/;
const AMBIGUOUS_CHECK_ATTEMPTS = 4;

/** Keep equivalent pasted links on one client/server dedupe key. */
export function normalizeMeetingUrl(raw: string): string | null {
  const link = meetingLinkFromInput(raw);
  if (link === null) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

type SendIntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface SendIntent {
  key: string;
  input: { meeting_url: string; bot_name?: string };
  createdAt: number;
  /** The terminal meeting whose explicit resend started this intent. */
  afterMeetingId?: string;
}
const sendIntentStorage = (): SendIntentStorage | null => {
  try { return window.sessionStorage; } catch { return null; }
};
const sendIntentStorageKey = (owner: string, normalizedUrl: string) =>
  `${SEND_INTENT_PREFIX}${encodeURIComponent(owner.toLowerCase())}:${encodeURIComponent(normalizedUrl)}`;
const memorySendIntents = new Map<string, SendIntent>();

function validStoredIntent(raw: string | null): SendIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SendIntent>;
    // A tampered or truncated row is discarded rather than retried: the backend refuses a
    // malformed Idempotency-Key, which would otherwise wedge this URL for the whole session.
    if (!SEND_KEY_RE.test(value.key ?? "") || typeof value.input?.meeting_url !== "string"
      || value.input.meeting_url.length === 0
      || (value.input.bot_name !== undefined && typeof value.input.bot_name !== "string")
      || (value.createdAt !== undefined && (!Number.isFinite(value.createdAt) || value.createdAt! < 0))
      || (value.afterMeetingId !== undefined && typeof value.afterMeetingId !== "string")) return null;
    return { ...value, createdAt: value.createdAt ?? 0 } as SendIntent;
  } catch {
    return null;
  }
}

export function getOrCreateSendIntent(
  normalizedUrl: string,
  input: SendIntent["input"],
  afterMeetingId?: string,
  storage = sendIntentStorage(),
  owner = "",
): SendIntent {
  const storageKey = sendIntentStorageKey(owner, normalizedUrl);
  let stored: string | null = null;
  try { stored = storage?.getItem(storageKey) ?? null; } catch { /* Memory still works. */ }
  const existing = memorySendIntents.get(storageKey) ?? validStoredIntent(stored);
  const intent = existing
    ?? { key: `manual-v1-${crypto.randomUUID()}`, input, createdAt: Date.now(), ...(afterMeetingId ? { afterMeetingId } : {}) };
  memorySendIntents.set(storageKey, intent);
  try { storage?.setItem(storageKey, JSON.stringify(intent)); } catch { /* Memory still works. */ }
  return intent;
}

export function clearSendIntentKey(normalizedUrl: string, storage = sendIntentStorage(), owner = ""): void {
  const key = sendIntentStorageKey(owner, normalizedUrl);
  memorySendIntents.delete(key);
  try { storage?.removeItem(key); } catch { /* Already clear for this component. */ }
}

/** Remove one account's durable and memory-only send intents during sign-out. */
export function clearSendIntentsForOwner(owner: string, storage: Storage | null = sendIntentStorage() as Storage | null): void {
  const prefix = `${SEND_INTENT_PREFIX}${encodeURIComponent(owner.toLowerCase())}:`;
  for (const key of memorySendIntents.keys()) if (key.startsWith(prefix)) memorySendIntents.delete(key);
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(prefix));
    for (const key of keys) storage.removeItem(key);
  } catch { /* Sign-out must continue when browser storage is unavailable. */ }
}

export type ListStatus = "idle" | "loading" | "ready" | "dark" | "unavailable" | "offline" | "signed-out";

export interface OpenTranscriptState {
  id: string;
  status: "loading" | "pending" | "ready" | "missing" | "unavailable";
  meetingStatus?: TranscriberMeetingStatus;
  transcript?: TranscriberTranscript;
}

export type SaveState = "saving" | "saved" | "error";

export interface TranscriberViewProps {
  calendarOutcomes?: CalendarAutojoinOutcome[];
  listStatus: ListStatus;
  meetings: TranscriberListRow[];
  /** Per meeting id: whether its transcript has been copied into the user's space. */
  saved: Readonly<Record<string, SaveState>>;
  form: { url: string; botName: string; submitting: boolean; checking?: boolean; active?: boolean; error: string | null };
  busyId: string | null;
  open: OpenTranscriptState | null;
  onUrlChange: (value: string) => void;
  onBotNameChange: (value: string) => void;
  onSubmit: () => void;
  onRefresh: () => void;
  onStop: (id: string) => void;
  onToggleTranscript: (id: string) => void;
  onRemove: (id: string) => void;
  /** Send notetaker inside the form (default), or not: the Meeting sheet pins it in its footer. */
  sendInline?: boolean;
}

/** The notetaker form's id: Send notetaker submits it from the sheet's footer, outside the form. */
export const TRANSCRIBER_FORM_ID = "transcriber-form";

export function SendNotetakerButton(props: { form: TranscriberViewProps["form"]; listStatus: ListStatus }) {
  const canSubmit = props.listStatus !== "dark" && !props.form.submitting && !props.form.checking
    && !props.form.active && props.form.url.trim().length > 0;
  return (
    <Button
      type="submit"
      form={TRANSCRIBER_FORM_ID}
      size="lg"
      disabled={!canSubmit}
      aria-label="Send notetaker to meeting"
      className="w-full gap-1.5"
    >
      {(props.form.submitting || props.form.checking) && <Loader2Icon className="size-4 animate-spin" />}
      <span>{props.form.checking ? "Checking…" : props.form.submitting ? "Sending notetaker…" : "Send notetaker"}</span>
    </Button>
  );
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

// 48 px and 16 px text on touch (no iOS zoom on focus); compact with a mouse.
const inputClass =
  "h-12 w-full rounded-lg border border-input bg-background px-3 text-body shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 fine:h-10 fine:text-sm";

export const TranscriberView: FC<TranscriberViewProps> = ({
  calendarOutcomes = [],
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
  sendInline = true,
}) => {
  const dark = listStatus === "dark";

  return (
    <div className="flex flex-col gap-6" data-testid="meeting-bot">
      {dark ? (
        <p className="rounded-lg bg-surface-2 p-3 text-callout text-muted-foreground">
          Transcription isn&apos;t configured on this backend yet. Set{" "}
          <code className="font-mono">TRANSCRIPTION_API_URL</code> and{" "}
          <code className="font-mono">TRANSCRIPTION_API_KEY</code> to enable it.
        </p>
      ) : (
        <form
          id={TRANSCRIBER_FORM_ID}
          className="flex flex-col gap-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="transcriber-meeting-url" className="text-meta font-semibold">
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
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="transcriber-bot-name" className="text-meta font-semibold">
              Notetaker name (optional)
            </label>
            <input
              id="transcriber-bot-name"
              autoComplete="off"
              spellCheck={false}
              value={form.botName}
              disabled={form.submitting}
              onChange={(e) => onBotNameChange(e.target.value)}
              placeholder="TinyCloud Private Notetaker"
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-2">
            <RouteLine nodes={NOTETAKER_ROUTE} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <p className="min-w-0 text-callout text-muted-foreground">The transcript is saved to your space and shows up in Library.</p>
              <HowItWorksLink section="notetaker" />
            </div>
          </div>
          {form.error !== null && (
            <p role="alert" className="text-callout text-[var(--red-text)]">
              {form.error}
            </p>
          )}
          {form.checking && <p role="status" className="text-callout text-muted-foreground">Checking whether the notetaker joined…</p>}
          {form.active && !form.checking && <p role="status" className="text-callout text-muted-foreground">A notetaker is already joining this meeting.</p>}
          {sendInline && <SendNotetakerButton form={form} listStatus={listStatus} />}
        </form>
      )}

      {!dark && (
        <section aria-labelledby="transcriber-sessions" className="flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-0.5">
              <h3 id="transcriber-sessions" className="text-headline">
                Sessions
              </h3>
              <InfoTip label="About notetaker sessions">
                A notetaker leaves after five minutes with no one else in the call. You can end it from its row.
              </InfoTip>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onRefresh}
              aria-label="Refresh transcriber meetings"
              className="text-muted-foreground"
            >
              <RefreshCwIcon className={`size-4 ${listStatus === "loading" ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {(listStatus === "idle" || listStatus === "loading") && meetings.length === 0 && (
            <p className="mt-1 flex items-center gap-2 text-callout text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading…
            </p>
          )}
          {listStatus === "unavailable" && (
            <p className="mt-1 text-callout text-muted-foreground">
              The transcriber is temporarily unavailable. Nothing is lost — try again in a moment.
            </p>
          )}
          {listStatus === "offline" && (
            <p className="mt-1 text-callout text-muted-foreground">You appear to be offline, so this list may be incomplete.</p>
          )}
          {listStatus === "signed-out" && (
            <p className="mt-1 text-callout text-muted-foreground">Your session expired. Sign in again to see your meetings.</p>
          )}
          {listStatus === "ready" && meetings.length === 0 && (
            <p className="mt-1 text-callout text-muted-foreground">No meetings yet. Paste a link above to send the notetaker to one.</p>
          )}

          {calendarOutcomes.length > 0 && <div className="mt-3 rounded-lg border border-border p-3">
            <h4 className="text-meta font-semibold">Calendar autojoin outcomes</h4>
            <ul className="mt-2 space-y-2 text-meta">
              {calendarOutcomes.map((outcome) => <li key={outcome.id}>
                <span className="font-medium">{outcome.title || "Calendar meeting"}</span>
                <span className="text-muted-foreground"> · {formatWhen(new Date(outcome.start).toISOString())}</span>
                <p className="text-muted-foreground">{calendarOutcomeLabel(outcome.reason)}</p>
              </li>)}
            </ul>
          </div>}
          {meetings.length > 0 && (
            <ul className="mt-1 flex flex-col divide-y divide-border">
              {meetings.map((row) => (
                <li key={row.id} className="py-2.5">
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
        </section>
      )}
    </div>
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
  const when = formatWhen(meeting.metadata?.scheduled_start ?? meeting.created_at);
  const shared = meeting.metadata?.shared === true;
  const meta = [
    statusLabel(meeting.status),
    when,
    shared ? "Shared recording" : null,
    meeting.bot?.name,
    props.saveState === "saved" ? "Saved to your space" : null,
    props.saveState === "saving" ? "Saving to your space…" : null,
  ].filter(Boolean).join(" · ");
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={meeting.meeting_url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex min-h-11 items-center text-callout font-medium hover:underline fine:min-h-0"
          >
            <span className="line-clamp-2 [overflow-wrap:anywhere]">
              {meeting.metadata?.source === "google-calendar-autojoin" ? transcriberMeetingTitle(meeting) : meetingTitle(meeting.meeting_url)}
            </span>
          </a>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
            <span className="inline-flex items-center" aria-hidden="true">
              <span
                className={`size-1.5 rounded-full ${statusTone(meeting.status)} ${active ? "animate-pulse" : ""}`}
              />
            </span>
            {meta && <span>{meta}</span>}
            {props.saveState === "error" && (
              <span data-testid="meeting-save-error" className="text-[var(--red-text)]">Could not save to your space</span>
            )}
          </span>
          {meeting.status === "failed" && meeting.error && (
            <span className="mt-0.5 block text-xs text-[var(--red-text)]">{meeting.error.message}</span>
          )}
          <CaptureDetails meeting={meeting} />
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
              className="gap-1.5"
            >
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              <span>{busy ? "Ending…" : "End"}</span>
            </Button>
          )}
          {meeting.status === "completed" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open !== null}
              onClick={() => props.onToggleTranscript(meeting.id)}
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
              className="text-muted-foreground"
            >
              {shared ? "Remove from my list" : "Remove"}
            </Button>
          )}
        </div>
      </div>
      {open !== null && <TranscriptPanel open={open} />}
    </div>
  );
}

/** A completed transcript can still come from a bot that left unexpectedly. */
export function departureMessage(meeting: TranscriberMeeting): string | null {
  const capture = meeting.capture;
  if (capture?.failure_reason === "browser_crashed") return "The bot’s browser crashed.";
  if (capture?.failure_reason === "browser_closed") return "The bot’s browser closed unexpectedly.";
  switch (capture?.completion_reason) {
    case "left_alone":
    case "startup_alone":
      return "Bot reported an audio-silence timeout. This can also happen if audio capture stops.";
    case "evicted": return "Bot reported being removed or disconnected from the call.";
    case "max_bot_time_exceeded": return "Bot reached its meeting time limit.";
    case "stopped": return "Bot was stopped.";
    case "awaiting_admission_timeout": return "Bot timed out waiting to be admitted.";
    case "awaiting_admission_rejected": return "Bot was not admitted to the call.";
    case "join_failure":
    case "auth_session_missing":
    case "validation_error": return "Bot reported a connection or setup failure.";
  }
  if (capture?.provider_record_missing_at) return "The recording service lost track of this bot.";
  if (capture?.provider_status === "failed") return "Bot capture failed; the departure reason was not reported.";
  if (capture?.stop_requested_by === "join_deadline") return "Bot was asked to stop after waiting too long to join.";
  if (capture?.stop_requested_by === "user") return "A stop was requested for this bot.";
  if (["completed", "failed", "cancelled"].includes(meeting.status)) return "Departure reason unavailable for this recording.";
  return null;
}

function CaptureDetails({ meeting }: { meeting: TranscriberMeeting }) {
  const message = departureMessage(meeting);
  if (!message) return null;
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      <p>{message}</p>
      <details className="mt-1">
        <summary className="cursor-pointer">Recording diagnostics</summary>
        <dl className="mt-1 space-y-1 break-all">
          <div><dt className="inline font-medium">Meeting ID: </dt><dd className="inline select-all">{meeting.id}</dd></div>
          {meeting.capture?.completion_reason && <div><dt className="inline font-medium">Departure code: </dt><dd className="inline">{meeting.capture.completion_reason}</dd></div>}
          {meeting.capture?.failure_reason && <div><dt className="inline font-medium">Failure code: </dt><dd className="inline">{meeting.capture.failure_reason}</dd></div>}
          {meeting.capture?.ended_at && <div><dt className="inline font-medium">Capture ended: </dt><dd className="inline">{meeting.capture.ended_at}</dd></div>}
          {meeting.capture?.exit_code != null && <div><dt className="inline font-medium">Bot exit code: </dt><dd className="inline">{meeting.capture.exit_code}</dd></div>}
          {meeting.transcript_provider && <div><dt className="inline font-medium">Transcription provider: </dt><dd className="inline">{meeting.transcript_provider}</dd></div>}
          {meeting.fallback_from && <div><dt className="inline font-medium">Transcription fallback: </dt><dd className="inline">{meeting.fallback_from} → {meeting.transcript_provider ?? "unknown"}</dd></div>}
          {meeting.capture?.audio_activity === "not_reported" && <div>Live audio health was not reported by the recording service.</div>}
        </dl>
      </details>
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
                    {segment.speaker_name?.trim() && segment.speaker_name.trim() !== "Unknown" && (
                      <span className="font-medium">{segment.attribution === "overlap" ? "Overlapping speech"
                        : segment.attribution === "unknown" ? "Unknown speaker" : segment.speaker_name}: </span>
                    )}
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
      // TC-907: every notetaker is in a meeting; the backend relays ptx's "All N … are busy" text.
      if (result.code === "capacity_exhausted") {
        return result.message ?? "All TinyCloud notetakers are busy right now. Try again when one of the current meetings ends.";
      }
      return "The transcriber is temporarily unavailable. Try again in a moment.";
    case "rejected":
      switch (result.code) {
        case "invalid_meeting_url":
          return "That doesn't look like a meeting link.";
        case "unsupported_platform":
          return "That meeting platform isn't supported yet.";
        case "idempotency_conflict":
          return "This send could not be retried safely. Please send the notetaker again.";
        default:
          return result.message ?? "The transcriber refused that request.";
      }
    case "ok":
      return "";
  }
}

export interface MeetingBotOptions {
  backendUrl: string;
  sessionStore: SessionStore;
  /** Injectable for tests; defaults to the real client. */
  client?: TranscriberClient;
  /** Injectable for tests; defaults to the real calendar autojoin client. */
  calendar?: Pick<ReturnType<typeof createCalendarAutojoinClient>, "status">;
  /**
   * On screen. Capture stays mounted while hidden, so the list and calendar
   * reads, and the polling, run only while it shows; each return re-reads
   * them, as a fresh mount did.
   */
  active: boolean;
}

/** The notetaker's state and actions: one per app, from Capture. */
export interface MeetingBot {
  listStatus: ListStatus;
  meetings: TranscriberListRow[];
  saved: Readonly<Record<string, SaveState>>;
  form: TranscriberViewProps["form"];
  busyId: string | null;
  open: OpenTranscriptState | null;
  calendarOutcomes: CalendarAutojoinOutcome[];
  actions: {
    setUrl: (value: string) => void;
    setBotName: (value: string) => void;
    submit: () => void;
    refresh: () => void;
    stop: (id: string) => void;
    toggleTranscript: (id: string) => void;
    remove: (id: string) => void;
  };
}

/**
 * Which timers run: none while off screen. The calendar refresh runs while on
 * screen; the list poll only while a meeting is still moving (a settled list
 * costs nothing) and the backend has a transcriber.
 */
export function meetingBotTimers(input: { active: boolean; anyActive: boolean; listStatus: ListStatus }): { calendar: boolean; poll: boolean } {
  return { calendar: input.active, poll: input.active && input.anyActive && input.listStatus !== "dark" };
}

/** The meetings that are still moving (the In progress rows). */
export function activeMeetings(meetings: readonly TranscriberListRow[]): TranscriberMeeting[] {
  return meetings.filter((m): m is TranscriberMeeting => !("unavailable" in m) && ACTIVE_STATUSES.has(m.status));
}

export function activeMeetingForUrl(meetings: readonly TranscriberListRow[], normalizedUrl: string): TranscriberMeeting | null {
  return activeMeetings(meetings).find(meeting => normalizeMeetingUrl(meeting.meeting_url) === normalizedUrl) ?? null;
}

function terminalMeetingForUrl(meetings: readonly TranscriberListRow[], normalizedUrl: string): TranscriberMeeting | null {
  return meetings.find((meeting): meeting is TranscriberMeeting => !("unavailable" in meeting)
    && !ACTIVE_STATUSES.has(meeting.status) && normalizeMeetingUrl(meeting.meeting_url) === normalizedUrl) ?? null;
}

function terminalMeetingForIntent(
  meetings: readonly TranscriberListRow[],
  normalizedUrl: string,
  intent: SendIntent,
): TranscriberMeeting | null {
  return meetings.find((meeting): meeting is TranscriberMeeting => !(
    "unavailable" in meeting
  ) && !ACTIVE_STATUSES.has(meeting.status)
    && meeting.id !== intent.afterMeetingId
    && normalizeMeetingUrl(meeting.meeting_url) === normalizedUrl
    && intent.createdAt > 0
    && Date.parse(meeting.created_at) >= intent.createdAt) ?? null;
}

function isAmbiguousCreateFailure(result: TranscriberResult<unknown>): boolean {
  return result.status === "offline" || (result.status === "retryable" && result.httpStatus >= 500);
}

export function meetingBotViewProps(bot: MeetingBot): TranscriberViewProps {
  return {
    calendarOutcomes: bot.calendarOutcomes,
    listStatus: bot.listStatus,
    meetings: bot.meetings,
    saved: bot.saved,
    form: bot.form,
    busyId: bot.busyId,
    open: bot.open,
    onUrlChange: bot.actions.setUrl,
    onBotNameChange: bot.actions.setBotName,
    onSubmit: bot.actions.submit,
    onRefresh: bot.actions.refresh,
    onStop: bot.actions.stop,
    onToggleTranscript: bot.actions.toggleTranscript,
    onRemove: bot.actions.remove,
  };
}

export function useMeetingBot({ backendUrl, sessionStore, client, calendar: calendarClient, active }: MeetingBotOptions): MeetingBot {
  const apiRef = useRef<TranscriberClient | null>(null);
  if (apiRef.current === null) {
    apiRef.current = client ?? createTranscriberClient(backendUrl, { sessionStore });
  }
  const api = apiRef.current;
  const calendar = useMemo(
    () => calendarClient ?? createCalendarAutojoinClient(backendUrl, sessionStore),
    [calendarClient, backendUrl, sessionStore],
  );
  const [calendarOutcomes, setCalendarOutcomes] = useState<CalendarAutojoinOutcome[]>([]);
  const owner = sessionStore.getAddress?.()?.toLowerCase() ?? "";
  const sendIntents = useRef(new Map<string, SendIntent>());
  const intentMapKey = useCallback((normalizedUrl: string) => `${owner}\n${normalizedUrl}`, [owner]);
  const intentFor = useCallback((normalizedUrl: string, input: SendIntent["input"], after?: TranscriberMeeting) => {
    const mapKey = intentMapKey(normalizedUrl);
    let intent = sendIntents.current.get(mapKey)
      ?? getOrCreateSendIntent(normalizedUrl, input, after?.id, undefined, owner);
    // A click after the previously represented bot ended is a new send intent. Remember which
    // terminal row caused it so an ambiguous retry (including after reload) keeps this new key.
    if (after && intent.afterMeetingId !== after.id) {
      clearSendIntentKey(normalizedUrl, undefined, owner);
      intent = getOrCreateSendIntent(normalizedUrl, input, after.id, undefined, owner);
    }
    sendIntents.current.set(mapKey, intent);
    return intent;
  }, [intentMapKey, owner]);
  const clearIntent = useCallback((normalizedUrl: string) => {
    sendIntents.current.delete(intentMapKey(normalizedUrl));
    clearSendIntentKey(normalizedUrl, undefined, owner);
  }, [intentMapKey, owner]);

  const [listStatus, setListStatus] = useState<ListStatus>("idle");
  const [meetings, setMeetings] = useState<TranscriberListRow[]>([]);
  const [url, setUrl] = useState("");
  const urlRef = useRef(url);
  urlRef.current = url;
  const [botName, setBotName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkingIntent, setCheckingIntent] = useState<(SendIntent & { normalizedUrl: string; owner: string; error: string }) | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenTranscriptState | null>(null);
  const saved = useTranscriberSavedState();
  const submitLatch = useRef(false);

  const anyActive = activeMeetings(meetings).length > 0;
  const normalizedFormUrl = normalizeMeetingUrl(url);
  const activeForForm = normalizedFormUrl === null ? null : activeMeetingForUrl(meetings, normalizedFormUrl);
  // The notetaker needs Exo's online service: on a node on this computer it reads as "dark" (the Meeting action is
  // hidden, as when the backend has no notetaker) and nothing polls.
  const localNode = useLocalNode();
  const timers = meetingBotTimers({ active: active && !localNode, anyActive, listStatus: localNode ? "dark" : listStatus });

  // The calendar refresh: the next one is scheduled once the last has
  // settled, so a slow read never overlaps another; one that lands after the
  // notetaker left the screen is dropped.
  useEffect(() => {
    if (!timers.calendar) return;
    let current = true;
    let timer = 0;
    const refresh = async () => {
      try { const status = await calendar.status(); if (current) setCalendarOutcomes(status.outcomes); }
      catch { /* The connector displays status errors; manual recordings remain usable. */ }
      if (current) timer = window.setTimeout(() => void refresh(), CALENDAR_INTERVAL_MS);
    };
    void refresh();
    return () => { current = false; window.clearTimeout(timer); };
  }, [calendar, timers.calendar]);

  // One list read at a time. Each visit to the screen is a generation: leaving
  // it (or unmounting) moves on, and a read still out from an earlier one is
  // dropped when it lands, so nothing updates off screen.
  const generation = useRef(0);
  const reading = useRef<number | null>(null);
  const load = useCallback(async () => {
    const mine = generation.current;
    if (reading.current === mine) return;
    reading.current = mine;
    setListStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const result = await api.list();
      if (mine !== generation.current) return;
      setListStatus(listStatusOf(result));
      if (result.status === "ok") setMeetings(result.value.meetings);
    } finally {
      if (reading.current === mine) reading.current = null;
    }
  }, [api]);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load, active]);

  // A transport/server failure does not prove the create failed: ingress can cut the response
  // while this backend and ptx commit later. Check this intent a bounded number of times; its URL
  // stays disabled, while another URL can still be sent and stale outcomes cannot overwrite it.
  useEffect(() => {
    if (checkingIntent === null) return;
    if (checkingIntent.owner !== owner) {
      setCheckingIntent(null);
      return;
    }
    let current = true;
    let timer = 0;
    let attempts = 0;
    const finish = () => {
      if (!current) return;
      if (normalizeMeetingUrl(urlRef.current) === checkingIntent.normalizedUrl) {
        setFormError(checkingIntent.error);
      }
      setCheckingIntent(value => value?.key === checkingIntent.key ? null : value);
    };
    const check = async () => {
      attempts++;
      const result = await api.list();
      if (!current) return;
      setListStatus(listStatusOf(result));
      if (result.status !== "ok") {
        timer = window.setTimeout(attempts < AMBIGUOUS_CHECK_ATTEMPTS ? () => void check() : finish, POLL_INTERVAL_MS);
        return;
      }
      setMeetings(result.value.meetings);
      if (activeMeetingForUrl(result.value.meetings, checkingIntent.normalizedUrl)) {
        if (normalizeMeetingUrl(urlRef.current) === checkingIntent.normalizedUrl) setFormError(null);
      } else {
        if (terminalMeetingForIntent(result.value.meetings, checkingIntent.normalizedUrl, checkingIntent)) {
          clearIntent(checkingIntent.normalizedUrl);
        }
        if (normalizeMeetingUrl(urlRef.current) === checkingIntent.normalizedUrl) {
          setFormError(checkingIntent.error);
        }
      }
      setCheckingIntent(value => value?.key === checkingIntent.key ? null : value);
    };
    void check();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, checkingIntent, clearIntent, owner]);

  // The poll: the next read is scheduled only after the last one settled.
  useEffect(() => {
    if (!timers.poll) return;
    let current = true;
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        void load().finally(() => {
          if (current) next();
        });
      }, POLL_INTERVAL_MS);
    };
    next();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [timers.poll, load]);

  const submit = useCallback(() => {
    const trimmed = url.trim();
    // Pasted forms (no https://, google.com/meet/<code>, a Calendar redirect) become the link ptx joins.
    const link = meetingLinkFromInput(trimmed);
    const normalized = link === null ? null : normalizeMeetingUrl(link);
    const checkingForUrl = checkingIntent?.normalizedUrl === normalized;
    if (trimmed.length === 0 || submitLatch.current || submitting || checkingForUrl || activeForForm) return;
    if (link === null || normalized === null) {
      setFormError("That doesn't look like a meeting link.");
      return;
    }
    const input = {
      meeting_url: link,
      ...(botName.trim() ? { bot_name: botName.trim() } : {}),
    };
    const intent = intentFor(normalized, input, terminalMeetingForUrl(meetings, normalized) ?? undefined);
    submitLatch.current = true;
    setSubmitting(true);
    setFormError(null);
    void (async () => {
      try {
        // Preserve fragments in the stable request: Signal uses one as its join capability.
        const result = await api.create(intent.input, { idempotencyKey: intent.key });
        if (result.status !== "ok") {
          if (isAmbiguousCreateFailure(result)) {
            setCheckingIntent({ ...intent, normalizedUrl: normalized, owner, error: describeFailure(result) });
            return;
          }
          if (result.status === "rejected" && result.code === "idempotency_conflict") clearIntent(normalized);
          setFormError(describeFailure(result));
          return;
        }
        if (!ACTIVE_STATUSES.has(result.value.status)) clearIntent(normalized);
        setUrl("");
        setMeetings((current) => [result.value, ...current.filter((m) => m.id !== result.value.id)]);
        setListStatus("ready");
      } catch {
        const message = "The transcriber is temporarily unavailable. Try again in a moment.";
        setCheckingIntent({ ...intent, normalizedUrl: normalized, owner, error: message });
      } finally {
        submitLatch.current = false;
        setSubmitting(false);
      }
    })();
  }, [activeForForm, api, botName, checkingIntent, clearIntent, intentFor, meetings, owner, submitting, url]);

  const stop = useCallback(
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

  const remove = useCallback(
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

  const toggleTranscript = useCallback(
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

  const refresh = useCallback(() => void load(), [load]);
  const actions = useMemo(
    () => ({ setUrl, setBotName, submit, refresh, stop, toggleTranscript, remove }),
    [submit, refresh, stop, toggleTranscript, remove],
  );

  return {
    listStatus: localNode ? "dark" : listStatus,
    meetings,
    saved,
    form: {
      url,
      botName,
      submitting,
      checking: checkingIntent?.normalizedUrl === normalizedFormUrl,
      active: activeForForm !== null,
      error: formError,
    },
    busyId,
    open,
    calendarOutcomes,
    actions,
  };
}
