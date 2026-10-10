// Where a saved voice note's on-device transcription stands, read from the
// phone's own state: the note's committed mode (`options.transcriber`), the
// native sidecar's `stt`, the live queue, and the plugin's progress events.
// Shown in place of "No transcript." for a Local note that is waiting for the
// model, queued, running, failed, silent, or done but not yet in the space.
// While the note's mode and state are still being read, it says so.
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { VoiceNotes, type NoteSttState } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt, type OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import {
  downloadOnDeviceModel,
  onDeviceSttStore,
  retryOnDeviceNote,
} from "@/lib/voiceNotes/onDeviceSttStore";
import { localModelGuide } from "@/capture/recorder/final/localModelGuide";

export type OnDeviceNote =
  | { kind: "none" }
  | { kind: "waiting_for_model" }
  | { kind: "queued" }
  | { kind: "running"; percent: number | null }
  | { kind: "failed"; reason: string }
  | { kind: "no_speech" }
  | { kind: "done" };

type Outcome = "transcribed" | "no_speech";

/** What one native scan found for a note. `local` is the note's committed mode; only Local notes have an on-device state. */
interface Scan {
  noteId: string;
  local: boolean;
  stt: NoteSttState | null;
  outcome: Outcome | null;
}

/** What the plugin's events said last: a progress tick, or the end of the job. */
type Live =
  | { noteId: string; kind: "running"; percent: number }
  | { noteId: string; kind: "done"; outcome: Outcome | null };

export interface OnDeviceNoteView {
  /** Null while this note's mode and state are still being read. */
  note: OnDeviceNote | null;
  error: string | null;
  reload: () => void;
}

/** The note's on-device state; a failed read is `error`, with `reload`. State is kept per note id. */
export function useOnDeviceNote(noteId: string): OnDeviceNoteView {
  const status = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const [scan, setScan] = useState<Scan | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let latest = 0;
    setScan(null);
    setLive(null);
    setError(null);
    const read = () => {
      const mine = ++latest;
      const current = () => alive && mine === latest;
      const found = async (): Promise<Scan> => {
        const { recordings } = await VoiceNotes.listPending();
        const recording = recordings.find((candidate) => candidate.id === noteId);
        const stt = recording?.stt ?? null;
        const local = recording?.options?.transcriber === "on-device";
        const outcome = local && stt?.state === "done" ? ((await VoiceNotes.getTranscript({ id: noteId })).transcript?.outcome ?? null) : null;
        return { noteId, local, stt, outcome };
      };
      found().then(
        (result) => {
          if (!current()) return;
          setScan(result);
          setError(null);
        },
        (caught: unknown) => {
          console.error("[Library] Could not read this note's on-device transcription", noteId, caught);
          if (current()) setError(`Couldn't check this note's on-device transcription: ${caught instanceof Error ? caught.message : String(caught)}`);
        },
      );
    };
    read();
    const subs = [
      OnDeviceStt.addListener("progress", (event) => {
        if (event.id === noteId) setLive({ noteId, kind: "running", percent: event.percent });
      }),
      OnDeviceStt.addListener("transcribed", (event) => {
        if (event.id !== noteId) return;
        setLive({ noteId, kind: "done", outcome: event.outcome ?? null });
        read();
      }),
      OnDeviceStt.addListener("failed", (event) => {
        if (event.id !== noteId) return;
        setLive(null);
        read();
      }),
    ];
    for (const sub of subs) sub.catch((caught: unknown) => console.error("[Library] Could not follow on-device transcription", caught));
    return () => {
      alive = false;
      for (const sub of subs) sub.then((handle) => handle.remove()).catch(() => {});
    };
  }, [noteId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const job = status.queue.find((entry) => entry.id === noteId) ?? null;
  return { note: onDeviceNote(scan?.noteId === noteId ? scan : null, live?.noteId === noteId ? live : null, job), error, reload };
}

/**
 * The live queue wins, then the plugin's latest event, then the sidecar. A note only has an
 * on-device state when its committed mode is Local (the queue never holds any other); with
 * nothing known yet the answer is null, never "none".
 */
export function onDeviceNote(scan: Scan | null, live: Live | null, job: OnDeviceSttStatus["queue"][number] | null): OnDeviceNote | null {
  if (scan === null && live === null && job === null) return null;
  if (job === null && live === null && scan !== null && !scan.local) return { kind: "none" };
  const state = job?.state ?? live?.kind ?? scan?.stt?.state;
  if (state === undefined) return { kind: "none" };
  switch (state) {
    case "waiting_for_model":
      return { kind: "waiting_for_model" };
    case "queued":
      return { kind: "queued" };
    case "running":
      return { kind: "running", percent: job?.percent ?? (live?.kind === "running" ? live.percent : null) };
    case "failed":
      return { kind: "failed", reason: job?.error ?? scan?.stt?.error ?? "unknown error" };
    case "cancelled":
      return { kind: "failed", reason: "it was cancelled" };
    case "done": {
      const outcome = (live?.kind === "done" ? live.outcome : null) ?? scan?.outcome ?? null;
      return outcome === "no_speech" ? { kind: "no_speech" } : { kind: "done" };
    }
  }
}

function ModelDownload() {
  const status = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const [startError, setStartError] = useState<string | null>(null);
  const guide = localModelGuide(status.models.length > 0 ? status : null, {
    start: () => {
      setStartError(null);
      void downloadOnDeviceModel().then(setStartError);
    },
    error: startError,
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="voice-note-model-download">
      <p className="min-w-0 flex-1 text-callout text-muted-foreground">{guide.reason}</p>
      {guide.action && (
        <Button type="button" variant="outline" onClick={guide.action.run} data-testid="voice-note-model-download-action">
          {guide.action.label}
        </Button>
      )}
    </div>
  );
}

export function OnDeviceNoteStatusView(props: {
  noteId: string;
  view: OnDeviceNoteView;
  fallback: ReactNode;
}) {
  const { note, error, reload } = props.view;
  const [retryError, setRetryError] = useState<string | null>(null);
  if (error !== null) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="voice-note-on-device-read-failed">
        <p role="alert" className="min-w-0 flex-1 text-callout text-destructive">{error}</p>
        <Button type="button" variant="outline" onClick={reload}>
          <RefreshCwIcon aria-hidden /> Try again
        </Button>
      </div>
    );
  }
  if (note === null) {
    return (
      <p role="status" className="flex items-center gap-2 text-callout text-muted-foreground" data-testid="voice-note-on-device-checking">
        <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> Checking this note&apos;s transcription…
      </p>
    );
  }
  switch (note.kind) {
    case "none":
      return <>{props.fallback}</>;
    case "waiting_for_model":
      return (
        <div className="flex flex-col gap-2" data-testid="voice-note-on-device-waiting">
          <p role="status" className="flex items-center gap-2 text-callout text-muted-foreground">
            <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> Waiting for the on-device model. This note is transcribed on this phone once it has downloaded.
          </p>
          <ModelDownload />
        </div>
      );
    case "queued":
      return (
        <p role="status" className="flex items-center gap-2 text-callout text-muted-foreground" data-testid="voice-note-on-device-queued">
          <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> Queued to transcribe on this phone…
        </p>
      );
    case "running":
      return (
        <p role="status" className="flex items-center gap-2 text-callout text-muted-foreground" data-testid="voice-note-on-device-running">
          <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden /> Transcribing on this phone{note.percent === null ? "…" : `… ${Math.round(note.percent)}%`}
        </p>
      );
    case "failed":
      return (
        <div className="flex flex-col gap-2" data-testid="voice-note-on-device-failed">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p role="alert" className="min-w-0 flex-1 text-callout text-destructive">Couldn&apos;t transcribe on this phone: {note.reason}</p>
            <Button
              type="button"
              variant="outline"
              data-testid="voice-note-on-device-retry"
              onClick={() => {
                setRetryError(null);
                void retryOnDeviceNote(props.noteId).then(setRetryError);
              }}
            >
              <RefreshCwIcon aria-hidden /> Retry
            </Button>
          </div>
          {retryError && <p role="alert" className="text-callout text-destructive">{retryError}</p>}
        </div>
      );
    case "no_speech":
      return (
        <p role="status" className="text-callout text-muted-foreground" data-testid="voice-note-on-device-no-speech">
          No speech was found in this note.
        </p>
      );
    case "done":
      return (
        <p role="status" className="text-callout text-muted-foreground" data-testid="voice-note-on-device-done">
          Transcribed on this phone. It&apos;s being added to this note.
        </p>
      );
  }
}

function OnDeviceNoteStatusReading(props: { noteId: string; fallback: ReactNode }) {
  const view = useOnDeviceNote(props.noteId);
  return <OnDeviceNoteStatusView noteId={props.noteId} view={view} fallback={props.fallback} />;
}

/** Only a phone with on-device speech has a state to read; elsewhere the fallback stands. */
export function OnDeviceNoteStatus(props: { noteId: string; fallback: ReactNode }) {
  if (!captureCapabilities().localTranscription) return <>{props.fallback}</>;
  return <OnDeviceNoteStatusReading {...props} />;
}
