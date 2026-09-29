// The VOICE NOTES card in Connectors → Sources, shown only inside the Exo
// mobile app (the native plugin is the capture engine). Record on the device,
// save to the user's TinyCloud space, play back from the space.
//
// `VoiceNotesView` is the whole rendered surface and a pure function of its
// props; `VoiceNotesSection` owns the plugin, its OS mic-state events and the
// storage calls.

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Loader2Icon, MicIcon, PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import {
  VoiceNotes,
  nativePlatform,
  nativeVoiceNotesAvailable,
  type MicState,
  type MicStateReason,
  type VoiceNoteRecording,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import {
  listVoiceNotes,
  loadVoiceNoteAudio,
  saveVoiceNote,
  type VoiceNoteListItem,
} from "@/lib/voiceNotes/voiceNoteStore";

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping" | "saving";

export interface VoiceNotesViewProps {
  phase: RecorderPhase;
  mic: { state: MicState; reason: MicStateReason };
  elapsedMs: number;
  level: number;
  error: string | null;
  notes: VoiceNoteListItem[];
  notesStatus: "loading" | "ready" | "error";
  playing: { sourceId: string; src: string | null } | null;
  /** Recordings still only on this phone (a save failed or was interrupted). */
  pendingCount: number;
  retrying: boolean;
  onRecord: () => void;
  onStop: () => void;
  onPlay: (sourceId: string) => void;
  onRetry: () => void;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Copy for what the OS is telling us about the microphone. */
export function micStatusText(phase: RecorderPhase, mic: { state: MicState; reason: MicStateReason }, elapsedMs: number): string {
  if (phase === "starting") return "Starting the microphone…";
  if (phase === "stopping" || phase === "saving") return "Saving to your TinyCloud space…";
  if (phase !== "recording") return "Not recording. The microphone is off.";
  if (mic.state === "silenced") {
    return `Recording ${formatDuration(elapsedMs)}, but the system is blocking the microphone (a call, another app, or the mic privacy toggle).`;
  }
  if (mic.reason === "no_signal") {
    return `Recording ${formatDuration(elapsedMs)}, but no sound is reaching the microphone.`;
  }
  return `Recording ${formatDuration(elapsedMs)}`;
}

export const VoiceNotesView: FC<VoiceNotesViewProps> = (props) => {
  const { phase, mic, elapsedMs, level, error, notes, notesStatus, playing, pendingCount, retrying } = props;
  const live = phase === "recording";
  const busy = phase === "starting" || phase === "stopping" || phase === "saving";
  const warn = live && (mic.state === "silenced" || mic.reason === "no_signal");

  return (
    <SectionCard icon={MicIcon} title="Voice notes">
      <p className="text-xs text-muted-foreground">
        Record a note on this phone. It is saved to your TinyCloud space and shows up in Library.
        While Exo records, your phone shows its microphone indicator and a notification.
      </p>

      <div className="mt-3 flex items-center gap-3">
        {live ? (
          <Button type="button" variant="destructive" onClick={props.onStop} data-testid="voice-note-stop">
            <SquareIcon className="size-4" /> Stop
          </Button>
        ) : (
          <Button type="button" onClick={props.onRecord} disabled={busy} data-testid="voice-note-record">
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <MicIcon className="size-4" />} Record
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <p
            role="status"
            data-testid="voice-note-status"
            data-mic-state={live ? mic.state : "idle"}
            data-mic-reason={live ? mic.reason ?? "" : ""}
            className={`text-sm ${warn ? "text-amber-600 dark:text-amber-400" : live ? "text-foreground" : "text-muted-foreground"}`}
          >
            {live && <span className={`mr-2 inline-block size-2 rounded-full ${warn ? "bg-amber-500" : "bg-red-500"}`} aria-hidden />}
            {micStatusText(phase, mic, elapsedMs)}
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
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border px-3 py-2" data-testid="voice-note-pending">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {pendingCount === 1 ? "1 note is" : `${pendingCount} notes are`} on this phone but not yet in your
            TinyCloud space.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={props.onRetry} disabled={retrying || busy} data-testid="voice-note-retry">
            {retrying ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />} Save now
          </Button>
        </div>
      )}

      <div className="mt-4">
        {notesStatus === "loading" && <p className="text-xs text-muted-foreground">Loading your voice notes…</p>}
        {notesStatus === "error" && <p className="text-xs text-muted-foreground">Could not load your voice notes.</p>}
        {notesStatus === "ready" && notes.length === 0 && (
          <p className="text-xs text-muted-foreground">No voice notes yet.</p>
        )}
        {notes.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {notes.map((note) => (
              <li key={note.id} data-testid="voice-note-item" data-source-id={note.sourceId} className="py-2">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{note.title ?? "Voice note"}</p>
                    {note.durationSecs !== null && (
                      <p className="text-xs text-muted-foreground">{formatDuration(note.durationSecs * 1000)}</p>
                    )}
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => props.onPlay(note.sourceId)} aria-label="Play voice note">
                    <PlayIcon className="size-4" />
                  </Button>
                </div>
                {playing?.sourceId === note.sourceId && (
                  playing.src ? (
                    <audio className="mt-2 w-full" controls autoPlay src={playing.src} data-testid="voice-note-player" />
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">Loading audio…</p>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

/** Recordings being uploaded right now, across mounts (StrictMode mounts effects twice). */
const savesInFlight = new Set<string>();

/**
 * Upload one stopped recording; the device copy is deleted only after the save is confirmed.
 * Returns null when saved (or already being saved elsewhere), else the failure message.
 * The in-flight guard matters because upsertMeeting's select-then-insert is not atomic: two
 * concurrent saves of one recording would write two rows.
 */
async function saveRecording(tcw: TinyCloudWeb, recording: VoiceNoteRecording): Promise<string | null> {
  if (savesInFlight.has(recording.id)) return null;
  savesInFlight.add(recording.id);
  try {
    const audio = await VoiceNotes.readAudio({ id: recording.id });
    const saved = await saveVoiceNote(tcw, recording, audio, nativePlatform());
    if (!saved.ok) return saved.error.message;
    await VoiceNotes.deleteAudio({ id: recording.id });
    return null;
  } catch (caught) {
    return messageOf(caught);
  } finally {
    savesInFlight.delete(recording.id);
  }
}

interface PendingRun {
  total: number;
  left: VoiceNoteRecording[];
  lastError: string | null;
}

let pendingRunInFlight: Promise<PendingRun> | null = null;

/** Retry every recording still on the device, oldest first, one at a time. Single-flight. */
function savePendingRecordings(tcw: TinyCloudWeb): Promise<PendingRun> {
  if (pendingRunInFlight) return pendingRunInFlight;
  pendingRunInFlight = (async () => {
    const { recordings } = await VoiceNotes.listPending();
    const left: VoiceNoteRecording[] = [];
    let lastError: string | null = null;
    for (const recording of [...recordings].sort((a, b) => a.startedAt - b.startedAt)) {
      const failure = await saveRecording(tcw, recording);
      if (failure) {
        left.push(recording);
        lastError = failure;
      }
    }
    return { total: recordings.length, left, lastError };
  })().finally(() => {
    pendingRunInFlight = null;
  });
  return pendingRunInFlight;
}

function VoiceNotesController({ tcw }: { tcw: TinyCloudWeb }) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [mic, setMic] = useState<{ state: MicState; reason: MicStateReason }>({ state: "idle", reason: null });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<VoiceNoteListItem[]>([]);
  const [notesStatus, setNotesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [playing, setPlaying] = useState<{ sourceId: string; src: string | null } | null>(null);
  const [pending, setPending] = useState<VoiceNoteRecording[]>([]);
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const res = await listVoiceNotes(tcw);
    if (!mounted.current) return;
    if (res.ok) {
      setNotes(res.data);
      setNotesStatus("ready");
    } else {
      setNotesStatus("error");
    }
  }, [tcw]);

  const retryPending = useCallback(async () => {
    setRetrying(true);
    setError(null);
    try {
      const run = await savePendingRecordings(tcw);
      if (!mounted.current) return;
      setPending(run.left);
      if (run.lastError) setError(`Some notes could not be saved yet: ${run.lastError}`);
      if (run.left.length < run.total) await refresh();
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught));
    } finally {
      if (mounted.current) setRetrying(false);
    }
  }, [refresh, tcw]);

  useEffect(() => {
    mounted.current = true;
    const handles = [
      VoiceNotes.addListener("micState", (event) => setMic({ state: event.state, reason: event.reason })),
      VoiceNotes.addListener("level", (event) => setLevel(event.level)),
    ];
    // A WebView reload mid-recording leaves the native recorder running; pick it back up.
    void VoiceNotes.status().then((status) => {
      if (!mounted.current || status.state === "idle") return;
      setMic({ state: status.state, reason: status.reason });
      setStartedAt(Date.now() - status.elapsedMs);
      setPhase("recording");
    });
    void refresh();
    // Anything left from an earlier failed save or an app restart gets another try.
    void VoiceNotes.listPending().then(({ recordings }) => {
      if (!mounted.current || recordings.length === 0) return;
      setPending(recordings);
      void retryPending();
    });
    return () => {
      mounted.current = false;
      for (const handle of handles) void handle.then((h) => h.remove());
    };
  }, [refresh, retryPending]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase]);

  const onRecord = useCallback(async () => {
    setError(null);
    setPlaying(null);
    setPhase("starting");
    try {
      const started = await VoiceNotes.start();
      setStartedAt(started.startedAt);
      setNow(Date.now());
      setMic({ state: "recording", reason: null });
      setPhase("recording");
    } catch (caught) {
      setError(messageOf(caught));
      setPhase("idle");
    }
  }, []);

  const onStop = useCallback(async () => {
    setPhase("stopping");
    try {
      const recording = await VoiceNotes.stop();
      setPhase("saving");
      const failure = await saveRecording(tcw, recording);
      if (failure) {
        // The audio stays on the device; nothing is lost if the save failed.
        setPending((current) => [...current.filter((r) => r.id !== recording.id), recording]);
        setError(`Recorded, but saving to your space failed: ${failure}`);
      } else {
        await refresh();
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      if (mounted.current) {
        setPhase("idle");
        setMic({ state: "idle", reason: null });
        setStartedAt(null);
        setLevel(0);
      }
    }
  }, [refresh, tcw]);

  const onPlay = useCallback(async (sourceId: string) => {
    setPlaying({ sourceId, src: null });
    const res = await loadVoiceNoteAudio(tcw, sourceId);
    if (!mounted.current) return;
    if (!res.ok) {
      setPlaying(null);
      setError(`Could not load that voice note: ${res.error.message}`);
      return;
    }
    setPlaying({ sourceId, src: `data:${res.data.mimeType};base64,${res.data.base64}` });
  }, [tcw]);

  return (
    <VoiceNotesView
      phase={phase}
      mic={mic}
      elapsedMs={startedAt === null ? 0 : now - startedAt}
      level={level}
      error={error}
      notes={notes}
      notesStatus={notesStatus}
      playing={playing}
      pendingCount={pending.length}
      retrying={retrying}
      onRecord={() => void onRecord()}
      onStop={() => void onStop()}
      onPlay={(id) => void onPlay(id)}
      onRetry={() => void retryPending()}
    />
  );
}

/** Renders nothing outside the Exo mobile app. */
export function VoiceNotesSection({ tcw }: { tcw: TinyCloudWeb }) {
  if (!nativeVoiceNotesAvailable()) return null;
  return <VoiceNotesController tcw={tcw} />;
}
