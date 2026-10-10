// Where a saved voice note's on-device transcription stands, read from the
// phone's own state (the native sidecar's `stt` plus the live queue). Shown in
// place of "No transcript." while the note is waiting for the model, queued,
// running, failed, or done but not yet in the space.
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
  | { kind: "done" };

/** The note's on-device state, or null while the first read is out. A failed read is `error`, with `reload`. */
export function useOnDeviceNote(noteId: string): { note: OnDeviceNote | null; error: string | null; reload: () => void } {
  const status = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const [durable, setDurable] = useState<NoteSttState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setDurable(undefined);
    setError(null);
    const read = () => {
      VoiceNotes.listPending().then(
        ({ recordings }) => {
          if (!live) return;
          setDurable(recordings.find((recording) => recording.id === noteId)?.stt ?? null);
          setError(null);
        },
        (caught: unknown) => {
          console.error("[Library] Could not read this note's on-device transcription", noteId, caught);
          if (live) setError(`Couldn't check this note's on-device transcription: ${caught instanceof Error ? caught.message : String(caught)}`);
        },
      );
    };
    read();
    const follow = (event: "transcribed" | "failed") =>
      OnDeviceStt.addListener(event, (done) => {
        if (done.id === noteId) read();
      });
    const subs = [follow("transcribed"), follow("failed")];
    for (const sub of subs) sub.catch((caught: unknown) => console.error("[Library] Could not follow on-device transcription", caught));
    return () => {
      live = false;
      for (const sub of subs) sub.then((handle) => handle.remove()).catch(() => {});
    };
  }, [noteId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const job = status.queue.find((entry) => entry.id === noteId) ?? null;
  // The live queue answers at once; the sidecar read (a native scan) fills in what the queue no longer holds.
  if (durable === undefined && job === null) return { note: null, error, reload };
  return { note: onDeviceNote(durable ?? null, job), error, reload };
}

/** The queue's live job wins over the sidecar's last write. */
export function onDeviceNote(durable: NoteSttState | null, job: OnDeviceSttStatus["queue"][number] | null): OnDeviceNote {
  const state = job?.state ?? durable?.state;
  if (state === undefined) return { kind: "none" };
  switch (state) {
    case "waiting_for_model":
      return { kind: "waiting_for_model" };
    case "queued":
      return { kind: "queued" };
    case "running":
      return { kind: "running", percent: job?.percent ?? null };
    case "failed":
      return { kind: "failed", reason: job?.error ?? durable?.error ?? "unknown error" };
    case "cancelled":
      return { kind: "failed", reason: "it was cancelled" };
    case "done":
      return { kind: "done" };
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
  view: { note: OnDeviceNote | null; error: string | null; reload: () => void };
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
  if (note === null) return <>{props.fallback}</>;
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
