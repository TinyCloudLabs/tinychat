// TC-515: record a voice note from a cold start without connectivity, inside
// the Exo mobile app only.
//
// Since TC-514 an offline launch keeps the session HELD and lands on the
// offline screen ("You're offline…" / "Can't reach Exo right now…" + Try
// again). That screen is shown here with a recorder. There is no space to save
// to yet, so Stop leaves the recording on the phone: the native plugin writes
// its sidecar at stop and `listPending()` returns it until a save is confirmed.
// The count of those is what the user is told will be saved. When the restore
// succeeds, PendingVoiceNotesSaver saves them through the Voice notes card's
// single-flight retry, and a recording still running is picked up by the chat
// screen's bar (QuickVoiceNote).
//
// Only the recorder half of the card is here: listing, playback, saving and
// transcription all need the space. Its copy for what the OS says about the
// microphone is the card's (`micStatusText`).

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  VoiceNotes,
  nativeVoiceNotesAvailable,
  type MicState,
  type MicStateReason,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { micStatusText } from "./VoiceNotesSection";

export type OfflineRecorderPhase = "idle" | "starting" | "recording" | "stopping";

export interface OfflineVoiceNotesViewProps {
  phase: OfflineRecorderPhase;
  mic: { state: MicState; reason: MicStateReason };
  elapsedMs: number;
  level: number;
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
  const { phase, mic, elapsedMs, level, error, pendingCount } = props;
  const live = phase === "recording";
  const busy = phase === "starting" || phase === "stopping";
  const warn = live && (mic.state === "silenced" || mic.reason === "no_signal");

  return (
    <section
      aria-label="Voice notes"
      data-testid="offline-voice-notes"
      className="w-full rounded-lg border border-border bg-card p-4 text-left"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <MicIcon className="size-4 text-muted-foreground" aria-hidden />
        Record a voice note
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        It stays on this phone and is saved to your TinyCloud space when you&apos;re back online.
      </p>

      <div className="mt-3 flex items-center gap-3">
        {live ? (
          <Button type="button" variant="destructive" onClick={props.onStop} className="h-11 shrink-0 md:h-9" data-testid="offline-voice-note-stop">
            <SquareIcon className="size-4" /> Stop
          </Button>
        ) : (
          <Button type="button" onClick={props.onRecord} disabled={busy} className="h-11 shrink-0 md:h-9" data-testid="offline-voice-note-record">
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <MicIcon className="size-4" />} Record
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <p
            role="status"
            data-testid="offline-voice-note-status"
            data-mic-state={live ? mic.state : "idle"}
            data-mic-reason={live ? mic.reason ?? "" : ""}
            className={`text-sm ${warn ? "text-amber-600 dark:text-amber-400" : live ? "text-foreground" : "text-muted-foreground"}`}
          >
            {live && <span className={`mr-2 inline-block size-2 rounded-full ${warn ? "bg-amber-500" : "bg-red-500"}`} aria-hidden />}
            {phase === "stopping" ? "Keeping it on this phone…" : micStatusText(phase, mic, elapsedMs)}
          </p>
          {live && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted" aria-hidden>
              <div className="h-full bg-foreground/60 transition-[width] duration-150" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {pendingCount > 0 && (
        <p className="mt-3 text-xs text-foreground" data-testid="offline-voice-note-pending">
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

interface OfflineVoiceNotesProps {
  /** Whether a recording is running, so the app can keep it on screen once the session is back. */
  onRecordingChange?: (recording: boolean) => void;
}

function OfflineVoiceNotesController({ onRecordingChange }: OfflineVoiceNotesProps) {
  const [phase, setPhaseState] = useState<OfflineRecorderPhase>("idle");
  const [mic, setMic] = useState<{ state: MicState; reason: MicStateReason }>({ state: "idle", reason: null });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const mounted = useRef(true);
  // The plugin's events read the phase as of now, not as of the render that subscribed.
  const phaseRef = useRef<OfflineRecorderPhase>("idle");
  const setPhase = useCallback((next: OfflineRecorderPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const reportRecording = useRef(onRecordingChange);
  useEffect(() => {
    reportRecording.current = onRecordingChange;
  }, [onRecordingChange]);

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
    setLevel(0);
    reportRecording.current?.(false);
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
      VoiceNotes.addListener("level", (event) => setLevel(event.level)),
    ];
    // A recording already running (started here before "Try again", or before a reload).
    void VoiceNotes.status().then((status) => {
      if (!mounted.current || status.state === "idle") return;
      setMic({ state: status.state, reason: status.reason });
      setStartedAt(Date.now() - status.elapsedMs);
      setPhase("recording");
      reportRecording.current?.(true);
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
      reportRecording.current?.(true);
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
      level={level}
      error={error}
      pendingCount={pendingCount}
      onRecord={() => void onRecord()}
      onStop={() => void onStop()}
    />
  );
}

/** Renders nothing outside the Exo mobile app. */
export function OfflineVoiceNotes(props: OfflineVoiceNotesProps) {
  if (!nativeVoiceNotesAvailable()) return null;
  return <OfflineVoiceNotesController {...props} />;
}
