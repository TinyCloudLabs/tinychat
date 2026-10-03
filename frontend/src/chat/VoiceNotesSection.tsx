// The VOICE NOTES card in Connectors → Sources, shown only inside the Exo
// mobile app (the native plugin is the capture engine). Record on the device,
// save to the user's TinyCloud space, play back from the space, and (when
// private cloud transcription is available to this build and account)
// transcribe each note into its transcript, which Library and meeting chat read.
//
// `VoiceNotesView` is the whole rendered surface and a pure function of its
// props; `VoiceNotesSection` owns the plugin, its OS mic-state events, the
// storage calls and the transcription queue.

import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { FileTextIcon, Loader2Icon, MicIcon, PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import type { PrivateCloudCapabilities } from "@/lib/privateCloud";
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
  type VoiceNoteAudio,
  type VoiceNoteListItem,
} from "@/lib/voiceNotes/voiceNoteStore";
import {
  createTranscriptionQueue,
  createVoiceNoteCloudForBuild,
  hasVoiceNoteTranscriptionConsent,
  maxTranscriptionSeconds,
  setVoiceNoteTranscriptionConsent,
  transcribeVoiceNote,
  transcriptionStatusText,
  type NoteTranscriptionState,
  type VoiceNoteCloud,
} from "@/lib/voiceNotes/voiceNoteTranscription";
import { PrivateCloudDisclosure } from "./PrivateCloudDisclosure";

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping" | "saving";

/**
 * Private cloud transcription as the card sees it. `hidden` (no PTX origin in
 * this build, or the backend's 404: dark or not in the cohort) and `checking`
 * offer nothing; `failed` means the check itself failed (offline, 5xx).
 */
export interface VoiceNoteTranscriptionProps {
  availability: "checking" | "available" | "hidden" | "failed";
  consented: boolean;
  /** The longest note offered, in seconds. */
  maxSeconds: number;
  /** Notes being transcribed, waiting their turn, or whose last attempt failed. */
  jobs: ReadonlyMap<string, NoteTranscriptionState>;
  onTranscribe: (sourceId: string) => void;
  onConsent: () => void;
  onTurnOff: () => void;
  onRecheck: () => void;
}

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
  /** Absent outside a build that can transcribe; nothing about transcription is shown then. */
  transcription?: VoiceNoteTranscriptionProps;
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

const VoiceNoteTranscriptionDisclosure: FC<{ maxSeconds: number }> = ({ maxSeconds }) => (
  <PrivateCloudDisclosure
    intro={
      <>
        Transcribe your voice notes so they show up as text in Library and in chat. After a note is saved, its
        audio (notes up to {Math.round(maxSeconds / 60)} minutes) is converted on this phone and uploaded over an
        encrypted connection to <strong>TinyCloud Private Transcription</strong>, a dedicated confidential virtual
        machine on Phala Cloud. It sends short speech segments to <strong>Tinfoil</strong> for speech-to-text.
      </>
    }
    originalStays="The voice note's audio stays in your TinyCloud space; its transcript is saved next to it."
  />
);

/** One note's transcript, progress or failure; null when there is nothing to show or offer. */
function NoteTranscription({
  note,
  transcription,
}: {
  note: VoiceNoteListItem;
  transcription: VoiceNoteTranscriptionProps | undefined;
}) {
  if (note.transcript.status === "transcribed") {
    return (
      <p data-testid="voice-note-transcript" className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-foreground/80">
        {note.transcript.preview}
      </p>
    );
  }
  if (note.transcript.status === "no_speech") {
    return (
      <p data-testid="voice-note-no-speech" className="mt-1 text-xs text-muted-foreground">
        No speech was found in this note.
      </p>
    );
  }
  if (!transcription) return null;
  const job = transcription.jobs.get(note.sourceId);
  if (job?.kind === "active") {
    return (
      <p role="status" data-testid="voice-note-transcription-status" className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" aria-hidden /> {transcriptionStatusText(job.status)}
      </p>
    );
  }
  const offered = transcription.availability === "available" && transcription.consented;
  if (job?.kind === "failed") {
    return (
      <div className="mt-1 flex items-start gap-2" data-testid="voice-note-transcription-failed">
        <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
          {job.message}
          {job.reference && <span className="text-muted-foreground"> Reference: {job.reference}</span>}
        </p>
        {offered && job.retryable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => transcription.onTranscribe(note.sourceId)}
            data-testid="voice-note-transcribe-retry"
          >
            <RefreshCwIcon className="size-4" /> Retry
          </Button>
        )}
      </div>
    );
  }
  if (!offered) return null;
  if (note.durationSecs !== null && note.durationSecs > transcription.maxSeconds) {
    return (
      <p data-testid="voice-note-too-long" className="mt-1 text-xs text-muted-foreground">
        Notes up to {Math.round(transcription.maxSeconds / 60)} minutes can be transcribed from the phone.
      </p>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="mt-1"
      onClick={() => transcription.onTranscribe(note.sourceId)}
      data-testid="voice-note-transcribe"
    >
      <FileTextIcon className="size-4" /> Transcribe
    </Button>
  );
}

/** The card-level transcription line: the one-time consent, or how to turn it off / check again. */
function TranscriptionControls({ transcription }: { transcription: VoiceNoteTranscriptionProps | undefined }) {
  if (!transcription) return null;
  if (transcription.availability === "available" && !transcription.consented) {
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-border px-3 py-2" data-testid="voice-note-transcription-consent">
        <VoiceNoteTranscriptionDisclosure maxSeconds={transcription.maxSeconds} />
        <Button type="button" size="sm" className="w-fit" onClick={transcription.onConsent} data-testid="voice-note-transcription-enable">
          Use private cloud
        </Button>
      </div>
    );
  }
  if (transcription.availability === "available") {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="voice-note-transcription-on">
        New notes are transcribed in private cloud.{" "}
        <button type="button" className="underline" onClick={transcription.onTurnOff}>
          Turn off
        </button>
      </p>
    );
  }
  // Only someone who chose private cloud hears that it is unreachable; nobody else is offered it.
  if (transcription.availability === "failed" && transcription.consented) {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="voice-note-transcription-unavailable">
        Private cloud transcription is unavailable right now.{" "}
        <button type="button" className="underline" onClick={transcription.onRecheck}>
          Check again
        </button>
      </p>
    );
  }
  return null;
}

export const VoiceNotesView: FC<VoiceNotesViewProps> = (props) => {
  const { phase, mic, elapsedMs, level, error, notes, notesStatus, playing, pendingCount, retrying, transcription } = props;
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

      <TranscriptionControls transcription={transcription} />

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
                <NoteTranscription note={note} transcription={transcription} />
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

type SaveOutcome = { saved: true; audio: VoiceNoteAudio | null } | { saved: false; failure: string | null };

/**
 * Upload one stopped recording; the device copy is deleted only after the save is confirmed.
 * Resolves `saved` with the audio it read (handed to transcription, so it is not read back),
 * or with the failure message (null when the recording is already being saved elsewhere).
 * The in-flight guard matters because upsertMeeting's select-then-insert is not atomic: two
 * concurrent saves of one recording would write two rows.
 */
async function saveRecording(tcw: TinyCloudWeb, recording: VoiceNoteRecording): Promise<SaveOutcome> {
  if (savesInFlight.has(recording.id)) return { saved: false, failure: null };
  savesInFlight.add(recording.id);
  try {
    const audio = await VoiceNotes.readAudio({ id: recording.id });
    const saved = await saveVoiceNote(tcw, recording, audio, nativePlatform());
    if (!saved.ok) return { saved: false, failure: saved.error.message };
    await VoiceNotes.deleteAudio({ id: recording.id });
    return { saved: true, audio: { mimeType: audio.mimeType, base64: audio.base64 } };
  } catch (caught) {
    return { saved: false, failure: messageOf(caught) };
  } finally {
    savesInFlight.delete(recording.id);
  }
}

interface PendingRun {
  total: number;
  left: VoiceNoteRecording[];
  saved: VoiceNoteRecording[];
  lastError: string | null;
}

let pendingRunInFlight: Promise<PendingRun> | null = null;

/** Retry every recording still on the device, oldest first, one at a time. Single-flight. */
function savePendingRecordings(tcw: TinyCloudWeb): Promise<PendingRun> {
  if (pendingRunInFlight) return pendingRunInFlight;
  pendingRunInFlight = (async () => {
    const { recordings } = await VoiceNotes.listPending();
    const left: VoiceNoteRecording[] = [];
    const saved: VoiceNoteRecording[] = [];
    let lastError: string | null = null;
    for (const recording of [...recordings].sort((a, b) => a.startedAt - b.startedAt)) {
      const outcome = await saveRecording(tcw, recording);
      if (outcome.saved) {
        saved.push(recording);
      } else if (outcome.failure) {
        left.push(recording);
        lastError = outcome.failure;
      }
    }
    return { total: recordings.length, left, saved, lastError };
  })().finally(() => {
    pendingRunInFlight = null;
  });
  return pendingRunInFlight;
}

/** Notes transcribe one at a time and keep going across mounts (PTX allows one active job per account). */
const transcriptionQueue = createTranscriptionQueue();

/** Waits between availability checks after one fails (plus the first try), as on the desktop. */
const CLOUD_CHECK_RETRY_MS = [2_000, 5_000];

interface ControllerProps {
  tcw: TinyCloudWeb;
  backendUrl?: string;
  sessionStore?: SessionStore;
}

function VoiceNotesController({ tcw, backendUrl, sessionStore }: ControllerProps) {
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

  // Private cloud transcription: null = this build has no PTX origin, so it is never offered.
  const cloud = useMemo<VoiceNoteCloud | null>(
    () => (backendUrl !== undefined && sessionStore !== undefined ? createVoiceNoteCloudForBuild(backendUrl, sessionStore) : null),
    [backendUrl, sessionStore],
  );
  const [availability, setAvailability] = useState<VoiceNoteTranscriptionProps["availability"]>(cloud ? "checking" : "hidden");
  const [capabilities, setCapabilities] = useState<PrivateCloudCapabilities | null>(null);
  const [checkRound, setCheckRound] = useState(0);
  const [consented, setConsented] = useState(hasVoiceNoteTranscriptionConsent);
  const [jobs, setJobs] = useState<ReadonlyMap<string, NoteTranscriptionState>>(() => new Map(transcriptionQueue.states()));

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

  /** Queue a note for transcription; `audio` saves reading it back from the space. */
  const transcribe = useCallback(
    (sourceId: string, audio?: VoiceNoteAudio) => {
      if (cloud === null || capabilities === null) return;
      transcriptionQueue.enqueue(sourceId, (report) =>
        transcribeVoiceNote({ tcw, cloud, capabilities, sourceId, audio, report }),
      );
    },
    [cloud, capabilities, tcw],
  );
  const autoTranscribe = availability === "available" && consented;
  /** A just-saved recording, transcribed when transcription is on and the note is within the limit. */
  const autoTranscribeRef = useRef<((recording: VoiceNoteRecording, audio?: VoiceNoteAudio) => void) | null>(null);
  autoTranscribeRef.current = autoTranscribe
    ? (recording, audio) => {
        if (recording.durationMs / 1000 > maxTranscriptionSeconds(capabilities)) return; // the card says why
        transcribe(recording.id, audio);
      }
    : null;

  const retryPending = useCallback(async () => {
    setRetrying(true);
    setError(null);
    try {
      const run = await savePendingRecordings(tcw);
      if (!mounted.current) return;
      setPending(run.left);
      if (run.lastError) setError(`Some notes could not be saved yet: ${run.lastError}`);
      if (run.left.length < run.total) await refresh();
      for (const recording of run.saved) autoTranscribeRef.current?.(recording);
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

  // Transcription progress (the queue outlives this view); a saved transcript refreshes the list.
  useEffect(
    () =>
      transcriptionQueue.subscribe((event) => {
        if (!mounted.current) return;
        setJobs(new Map(transcriptionQueue.states()));
        if (event.outcome === "saved") void refresh();
      }),
    [refresh],
  );

  // Whether private cloud can be offered: this build's PTX origin and the backend's 200 for this
  // account. A failed check (not a 404) is retried a bounded number of times, as on the desktop.
  useEffect(() => {
    if (cloud === null) return;
    let cancelled = false;
    setAvailability("checking");
    void (async () => {
      const check = async () => {
        try {
          const caps = await cloud.capabilities();
          return caps === null ? ({ state: "hidden" } as const) : ({ state: "available", caps } as const);
        } catch (err) {
          console.warn("Checking private cloud transcription failed", err);
          return { state: "failed" } as const;
        }
      };
      let result = await check();
      for (const waitMs of CLOUD_CHECK_RETRY_MS) {
        if (result.state !== "failed" || cancelled) break;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (cancelled) return;
        result = await check();
      }
      if (cancelled) return;
      setCapabilities(result.state === "available" ? result.caps : null);
      setAvailability(result.state);
    })();
    return () => {
      cancelled = true;
    };
  }, [cloud, checkRound]);

  // Jobs a previous launch left in flight are finished first (one active job per account).
  const resumed = useRef(false);
  useEffect(() => {
    if (!autoTranscribe || cloud === null || resumed.current) return;
    resumed.current = true;
    for (const sourceId of cloud.pendingSourceIds()) transcribe(sourceId);
  }, [autoTranscribe, cloud, transcribe]);

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
      const outcome = await saveRecording(tcw, recording);
      if (!outcome.saved) {
        // The audio stays on the device; nothing is lost if the save failed.
        setPending((current) => [...current.filter((r) => r.id !== recording.id), recording]);
        setError(`Recorded, but saving to your space failed: ${outcome.failure ?? "it is already being saved"}`);
      } else {
        await refresh();
        autoTranscribeRef.current?.(recording, outcome.audio ?? undefined);
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

  const transcription: VoiceNoteTranscriptionProps | undefined =
    cloud === null
      ? undefined
      : {
          availability,
          consented,
          maxSeconds: maxTranscriptionSeconds(capabilities),
          jobs,
          onTranscribe: (sourceId) => transcribe(sourceId),
          onConsent: () => {
            setVoiceNoteTranscriptionConsent(true);
            setConsented(true);
          },
          onTurnOff: () => {
            setVoiceNoteTranscriptionConsent(false);
            setConsented(false);
          },
          onRecheck: () => setCheckRound((n) => n + 1),
        };

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
      transcription={transcription}
    />
  );
}

/** Renders nothing outside the Exo mobile app. */
export function VoiceNotesSection(props: ControllerProps) {
  if (!nativeVoiceNotesAvailable()) return null;
  return <VoiceNotesController {...props} />;
}
