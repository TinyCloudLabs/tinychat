// The receipt when a recording lands (plan §2.7): it says where the note is,
// with the route's last node checked. A save that failed says the note is
// still on the phone and offers Save now. On-device transcription works signed
// out and offline, so its text (or "Couldn't transcribe on this phone" plus
// Retry) comes from the native STT queue directly, not from the space's
// transcript, which may still be unsaved or unsynced here.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { CheckIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { cn } from "@/lib/utils";
import { VoiceNotes, type LocalTranscript, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { receiptMetaText } from "./recorderCopy";
import { RouteLine, type RouteNode } from "./RouteLine";

export interface SavedReceiptProps {
  outcome: "local" | "saved" | "failed";
  localUpload?: "uploading" | "held" | "in-flight" | null;
  /** The saved note (absent after a failure). */
  saved?: { id: string; durationMs: number; at: number } | null;
  route: readonly RouteNode[];
  /** This note's chosen transcriber, looked up natively; null once it's known not to be on-device. */
  transcriber?: TranscriberId | null;
  /** Private cloud has the note now. */
  transcribing?: boolean;
  error?: string | null;
  /** A save of the notes on this phone is running. */
  retrying?: boolean;
  onOpen?: () => void;
  onDone: () => void;
  onSaveNow: () => void;
  onPlayingChange?: (playing: boolean) => void;
  className?: string;
}

/** On-device transcription's state for this note: the native queue while it runs (it drops out of
 * the queue once finished, win or lose), the terminal `transcribed`/`failed` event, and the
 * transcript itself once read. Works signed out and offline — never touches the space. */
function useOnDeviceReceipt(id: string | undefined, onDevice: boolean) {
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const [transcript, setTranscript] = useState<LocalTranscript | null>(null);
  const [terminal, setTerminal] = useState<{ kind: "transcribed" | "failed" } | null>(null);

  useEffect(() => {
    setTranscript(null);
    setTerminal(null);
    if (!id || !onDevice) return;
    let active = true;
    const read = () => {
      void VoiceNotes.getTranscript({ id }).then(
        ({ transcript: found }) => { if (active) setTranscript(found); },
        () => { /* Best-effort: the queue/terminal-event state below still renders. */ },
      );
    };
    read();
    const subs = [
      OnDeviceStt.addListener("transcribed", (event) => { if (active && event.id === id) { setTerminal({ kind: "transcribed" }); read(); } }),
      OnDeviceStt.addListener("failed", (event) => { if (active && event.id === id) setTerminal({ kind: "failed" }); }),
    ];
    return () => {
      active = false;
      for (const sub of subs) void sub.then((handle) => handle.remove());
    };
  }, [id, onDevice]);

  if (!id || !onDevice) return { kind: "none" as const };
  if (transcript) return { kind: "transcribed" as const, transcript };
  if (terminal?.kind === "failed") return { kind: "failed" as const };
  const queued = sttStatus.queue.find((job) => job.id === id);
  if (queued) return { kind: "pending" as const, state: queued.state };
  return { kind: "pending" as const, state: "queued" as const };
}

export function SavedReceipt(props: SavedReceiptProps) {
  const saved = props.outcome === "saved";
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (!props.saved) return;
    let active = true;
    setLocalUrl(null);
    setLocalError(null);
    void VoiceNotes.localAudioUrl({ id: props.saved.id }).then(
      ({ url }) => { if (active) setLocalUrl(Capacitor.convertFileSrc(url)); },
      (caught: unknown) => { if (active) setLocalError(`Could not open this phone's audio: ${caught instanceof Error ? caught.message : String(caught)}`); },
    );
    return () => { active = false; };
  }, [props.saved?.id]);
  const onDevice = useOnDeviceReceipt(props.saved?.id, props.transcriber === "on-device");
  return (
    <section
      aria-label="Saved on this phone"
      data-testid="voice-note-receipt"
      data-outcome={props.outcome}
      className={cn("flex flex-col gap-3 rounded-xl border border-border p-4 motion-safe:animate-rise-in", props.className)}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="flex items-center gap-2 text-headline">
          <CheckIcon className="size-5 text-primary" aria-hidden="true" /> Saved on this phone
        </h3>
        {props.saved && <p className="tnum text-meta text-muted-foreground">{receiptMetaText(props.saved.durationMs, props.saved.at)}</p>}
        {props.error && (
          <p role="alert" className="text-meta text-muted-foreground">
            {props.error}
          </p>
        )}
      </div>
      {localUrl && <MeetingAudioPlayer url={localUrl} onPlayingChange={props.onPlayingChange} />}
      {localError && <p role="alert" className="text-callout text-destructive">{localError}</p>}
      {!localUrl && !localError && props.saved && <p role="status" className="text-meta text-muted-foreground">Getting this phone&apos;s audio…</p>}
      <RouteLine nodes={props.route} landed={saved} />
      {props.outcome === "local" && <p className="text-meta text-muted-foreground">{
        props.localUpload === "held" ? "Kept on this phone. This note needs an ownership check before upload."
          : props.localUpload === "in-flight" ? "Another save is finishing in your TinyCloud space…"
          : "Saving to your TinyCloud space…"
      }</p>}
      {saved && <p className="text-meta text-muted-foreground">Saved to your TinyCloud space</p>}
      {saved && props.transcribing && <p className="text-meta text-muted-foreground">Transcribing in private cloud…</p>}
      {onDevice.kind === "pending" && (
        <p role="status" className="flex items-center gap-2 text-meta text-muted-foreground" data-testid="voice-note-on-device-pending">
          <Loader2Icon className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
          {onDevice.state === "waiting_for_model" ? "Waiting for the on-device model…" : "Transcribing on this phone…"}
        </p>
      )}
      {onDevice.kind === "transcribed" && (
        onDevice.transcript.outcome === "no_speech" ? (
          <p className="text-meta text-muted-foreground" data-testid="voice-note-on-device-no-speech">No speech was found in this note.</p>
        ) : (
          <div className="flex flex-col gap-1" data-testid="voice-note-on-device-transcript">
            <p className="text-meta text-muted-foreground">Transcribed on this phone</p>
            <p className="max-w-[60ch] whitespace-pre-wrap break-words text-callout">
              {onDevice.transcript.segments.map((segment) => segment.text).join(" ")}
            </p>
          </div>
        )
      )}
      {onDevice.kind === "failed" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="voice-note-on-device-failed">
          <p role="alert" className="min-w-0 flex-1 text-callout text-destructive">Couldn&apos;t transcribe on this phone.</p>
          {props.saved && (
            <Button type="button" variant="outline" onClick={() => void OnDeviceStt.enqueue({ id: props.saved!.id })} data-testid="voice-note-on-device-retry">
              <RefreshCwIcon aria-hidden /> Retry
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {saved || props.outcome === "local" ? (
          <>
            {props.onOpen && (
              <Button type="button" variant="outline" onClick={props.onOpen} data-testid="voice-note-receipt-open">
                Open
              </Button>
            )}
            <Button type="button" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
            <Button type="button" onClick={props.onSaveNow} disabled={props.retrying} data-testid="voice-note-retry">
              {props.retrying && <Loader2Icon className="animate-spin" aria-hidden="true" />} Save now
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
