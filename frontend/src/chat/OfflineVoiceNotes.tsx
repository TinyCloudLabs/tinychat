// TC-515: record a voice note from a cold start without connectivity, inside
// the Exo mobile app only.
//
// Since TC-514 an offline launch keeps the session HELD and lands on the
// offline screen ("You're offline…" / "Can't reach Exo right now…" + Try
// again). That screen is shown here with a recorder. There is no space to save
// to yet, so Stop leaves the recording on the phone: the native plugin writes
// its sidecar at stop and `listPending()` returns it until a save is confirmed.
// The count of those is what the user is told will be saved. When the restore
// succeeds, PendingVoiceNotesSaver saves them through the shared single-flight
// (recorderSaves.ts), and a recording still running is picked up by the
// recorder (RecorderProvider), never restarted.
//
// Only recording is here: listing, playback, saving and transcription all
// need the space. It looks like the recorder (status, timer, level trace, the
// Stop bar), says what the OS reports about the microphone in the recorder's
// words, and lights the Live Edge (liveCapture) while it records.

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { Loader2Icon, MicIcon, MicOffIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LevelTrace } from "@/capture/recorder/LevelTrace";
import { liveCapture } from "@/capture/recorder/liveCapture";
import { cn } from "@/lib/utils";
import {
  VoiceNotes,
  nativeVoiceNotesAvailable,
  type MicState,
  type MicStateReason,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { formatDuration, micWarning, micWarningSentence, recorderStatusText } from "@/capture/recorder/recorderCopy";

export type OfflineRecorderPhase = "idle" | "starting" | "recording" | "stopping";

export interface OfflineVoiceNotesViewProps {
  phase: OfflineRecorderPhase;
  mic: { state: MicState; reason: MicStateReason };
  elapsedMs: number;
  /** Input levels while recording, for the trace. */
  subscribeLevel: (listener: (level: number) => void) => () => void;
  error: string | null;
  /** Recordings on this phone that are not in the space yet. */
  pendingCount: number;
  onRecord: () => void;
  onStop: () => void;
}

export function offlinePendingText(count: number): string {
  return `${count === 1 ? "1 note" : `${count} notes`} will be saved when you're back online.`;
}

export const OfflineVoiceNotesView: FC<OfflineVoiceNotesViewProps> = (props) => {
  const { phase, mic, elapsedMs, error, pendingCount } = props;
  const live = phase === "recording";
  const busy = phase === "starting" || phase === "stopping";
  const warning = live ? micWarningSentence(mic) : null;
  const status =
    phase === "stopping" ? "Keeping it on this phone…" : phase === "idle" ? "Not recording. The microphone is off." : recorderStatusText(phase, mic, null);

  return (
    <section
      aria-label="Voice notes"
      data-testid="offline-voice-notes"
      className="w-full rounded-xl border border-border bg-card p-4 text-left"
    >
      <h2 className="flex items-center gap-2 text-callout font-semibold">
        <MicIcon className="size-4 text-muted-foreground" aria-hidden />
        Record a voice note
      </h2>
      <p className="mt-1 text-meta text-muted-foreground">
        It stays on this phone and is saved to your TinyCloud space when you&apos;re back online.
      </p>

      <p
        role="status"
        data-testid="offline-voice-note-status"
        data-mic-state={live ? mic.state : "idle"}
        data-mic-reason={live ? mic.reason ?? "" : ""}
        className={cn("mt-4 flex items-center gap-2 text-callout font-semibold", warning ? "text-warning" : live ? "text-foreground" : "text-muted-foreground")}
      >
        {live && warning && <MicOffIcon className="size-4" aria-hidden />}
        {live && !warning && <span className="size-2.5 rounded-full bg-live motion-safe:animate-live-pulse" aria-hidden />}
        {status}
      </p>
      {live && <p className="tnum mt-1 font-display text-[2.5rem] font-medium leading-[2.5rem]">{formatDuration(elapsedMs)}</p>}
      {warning && <p className="mt-2 text-callout text-warning">{warning}</p>}
      {live && <LevelTrace subscribe={props.subscribeLevel} tone={warning ? "warning" : "live"} className="mt-4" />}

      <div className="mt-4">
        {live ? (
          <Button
            type="button"
            variant="live"
            onClick={props.onStop}
            className="h-14 w-full justify-start gap-3 rounded-xl px-5 text-body font-semibold"
            data-testid="offline-voice-note-stop"
          >
            <SquareIcon className="fill-current" aria-hidden /> Stop
          </Button>
        ) : (
          <Button
            type="button"
            onClick={props.onRecord}
            disabled={busy}
            className="h-14 w-full justify-start gap-3 rounded-xl px-5 text-body font-semibold [&_svg]:size-5"
            data-testid="offline-voice-note-record"
          >
            {busy ? <Loader2Icon className="animate-spin" aria-hidden /> : <MicIcon aria-hidden />} Record
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-meta text-destructive">
          {error}
        </p>
      )}

      {pendingCount > 0 && (
        <p className="mt-3 text-meta text-foreground" data-testid="offline-voice-note-pending">
          {offlinePendingText(pendingCount)}
        </p>
      )}
    </section>
  );
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function OfflineVoiceNotesController() {
  const [phase, setPhaseState] = useState<OfflineRecorderPhase>("idle");
  const [mic, setMic] = useState<{ state: MicState; reason: MicStateReason }>({ state: "idle", reason: null });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const mounted = useRef(true);
  // The plugin's events read the phase as of now, not as of the render that subscribed.
  const phaseRef = useRef<OfflineRecorderPhase>("idle");
  const setPhase = useCallback((next: OfflineRecorderPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  // Levels fan out to the trace and the Live Edge without React state.
  const levelListeners = useRef(new Set<(level: number) => void>());
  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    const listeners = levelListeners.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const refreshPending = useCallback(async () => {
    try {
      const { recordings } = await VoiceNotes.listPending();
      if (mounted.current) setPendingCount(recordings.length);
    } catch (caught) {
      console.warn("[VoiceNotes] Listing the notes on this phone failed", caught);
    }
  }, []);

  const toIdle = useCallback(() => {
    if (!mounted.current) return;
    setPhase("idle");
    setMic({ state: "idle", reason: null });
    setStartedAt(null);
  }, [setPhase]);

  useEffect(() => {
    mounted.current = true;
    const handles = [
      VoiceNotes.addListener("micState", (event) => {
        setMic({ state: event.state, reason: event.reason });
        // Idle while we think it records: the recorder stopped by itself (its length limit).
        // The recording is on the phone like any other; count it.
        if (event.state === "idle" && phaseRef.current === "recording") {
          toIdle();
          void refreshPending();
        }
      }),
      VoiceNotes.addListener("level", (event) => {
        for (const listener of levelListeners.current) listener(event.level);
        liveCapture.setLevel(event.level);
      }),
    ];
    // A recording already running (started here before "Try again", or before a reload).
    void VoiceNotes.status().then((status) => {
      if (!mounted.current || status.state === "idle") return;
      setMic({ state: status.state, reason: status.reason });
      setStartedAt(Date.now() - status.elapsedMs);
      setPhase("recording");
    });
    void refreshPending();
    return () => {
      mounted.current = false;
      for (const handle of handles) void handle.then((h) => h.remove());
    };
  }, [refreshPending, setPhase, toIdle]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase]);

  // The Live Edge follows this recorder while it records (and lets go when it unmounts).
  const live = phase === "recording";
  const warning = live && micWarning(mic) !== null;
  useEffect(() => {
    if (!live) return;
    liveCapture.set({ source: "offline-voice-note", warning, startedAt });
    return () => {
      if (liveCapture.get()?.source === "offline-voice-note") liveCapture.set(null);
    };
  }, [live, warning, startedAt]);

  const onRecord = useCallback(async () => {
    setError(null);
    setPhase("starting");
    try {
      const started = await VoiceNotes.start();
      if (!mounted.current) return;
      setStartedAt(started.startedAt);
      setNow(Date.now());
      setMic({ state: "recording", reason: null });
      setPhase("recording");
    } catch (caught) {
      if (!mounted.current) return;
      setError(messageOf(caught));
      setPhase("idle");
    }
  }, [setPhase]);

  const onStop = useCallback(async () => {
    setPhase("stopping");
    try {
      // The plugin keeps the stopped recording on the phone until a save is confirmed.
      await VoiceNotes.stop();
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught));
    } finally {
      toIdle();
      await refreshPending();
    }
  }, [refreshPending, setPhase, toIdle]);

  return (
    <OfflineVoiceNotesView
      phase={phase}
      mic={mic}
      elapsedMs={startedAt === null ? 0 : now - startedAt}
      subscribeLevel={subscribeLevel}
      error={error}
      pendingCount={pendingCount}
      onRecord={() => void onRecord()}
      onStop={() => void onStop()}
    />
  );
}

/** Renders nothing outside the Exo mobile app. */
export function OfflineVoiceNotes() {
  if (!nativeVoiceNotesAvailable()) return null;
  return <OfflineVoiceNotesController />;
}
