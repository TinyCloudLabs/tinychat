// Fills `NotePipelineInput` (notePipeline.ts) from the live stores and runs the one action its blocker offers.
// `buildNotePipelineInput` is pure: it takes the stores' snapshots as plain facts, so a test composes fake stores
// and asserts what the selector says. The hooks only gather the facts (`useSyncExternalStore` over each store).
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { useRecorder } from "@/capture/recorder/RecorderProvider";
import type { RecorderCaptureIssue } from "@/capture/recorder/recorderReducer";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { PlatformContext } from "@/lib/platform";
import { localTranscriptionUnavailable } from "./captureEngine";
import { spaceLaneSnapshot, subscribeSpaceLane } from "./voiceNoteRows";
import {
  VoiceNotes,
  nativeVoiceNotesAvailable,
  type NoteSttState,
  type TranscriberId,
} from "./nativeVoiceNotes";
import {
  notePipeline,
  type NotePipeline,
  type NotePipelineInput,
  type PipelineActionKind,
  type PipelineCaptureIssue,
  type PipelineDevice,
  type PipelineModelState,
  type PipelineNotesSync,
  type PipelineOnDevice,
  type PipelineRoute,
} from "./notePipeline";
import { OnDeviceStt, type OnDeviceSttStatus } from "./onDeviceStt";
import { onDeviceQueuePlace } from "./onDeviceQueue";
import { downloadOnDeviceModel, onDeviceSttStore, retryOnDeviceNote } from "./onDeviceSttStore";
import {
  onDeviceTranscriptSyncState,
  subscribeOnDeviceTranscriptSync,
  syncOnDeviceTranscript,
  type OnDeviceTranscriptSyncState,
} from "./onDeviceTranscriber";
import { loadNote } from "./recordingNotes";
import { pendingStore, type PendingNote } from "./recorderSaves";
import {
  recordingNoteSyncError,
  recordingNoteSyncSkip,
  recordingNoteSyncedAt,
  recordingNoteSyncing,
  subscribeRecordingNoteSync,
  syncRecordingNote,
  voiceNoteMarkdownKvKey,
  voiceNoteTranscriptState,
  type NoteSyncSkipReason,
} from "./voiceNoteStore";
import type { NoteTranscriptionState } from "./voiceNoteTranscription";

// --- Facts: the stores' answers, as plain data ----------------------------------------------------------------

/** What the phone's own ledger says about a note (`VoiceNotes.listPending`): its committed route and its on-device job. */
export interface NativeNote {
  transcriber: TranscriberId | null;
  stt: NoteSttState | null;
}

/** The local Markdown of a note (`loadNote`): the revision, and whether there is anything written (text or moments). */
export interface LocalNoteFacts {
  editedAt: string;
  hasContent: boolean;
}

export interface NotePipelineFacts {
  id: string;
  device: PipelineDevice;
  online: boolean;
  /** The note is a row in the space. */
  saved: boolean;
  /** The row's metadata as the library read it (`transcription_outcome`, `note_kv_key`, `note_edited_at`); null before it is read. */
  rowMetadata: Record<string, unknown> | null;
  localNote: LocalNoteFacts | null;
  /** Null: not read, or this build has no phone ledger. */
  native: NativeNote | null;
  capture: { finalizing: boolean; issue: RecorderCaptureIssue | null };
  pending: PendingNote | null;
  lane: ReturnType<typeof spaceLaneSnapshot>;
  /** Null when this build has no on-device speech. */
  onDeviceStatus: OnDeviceSttStatus | null;
  transcriptSync: OnDeviceTranscriptSyncState | null;
  /** This note's private-cloud job (`transcriber.snapshot().jobs`). */
  cloudJob: NoteTranscriptionState | null;
  noteSync: { syncing: boolean; failed: boolean; skip: NoteSyncSkipReason | null; syncedAt: string | null };
}

// --- Route -----------------------------------------------------------------------------------------------------

/**
 * Where this note's transcript comes from. The note's committed mode (`options.transcriber` in the phone's ledger)
 * decides; a Local note is in private cloud only once the user moved it ("Use Private instead"), which shows as a
 * cloud job for it. A note this phone has no ledger entry for (a Mac, a browser, another phone's note) has no
 * committed mode: a cloud job says private cloud, a native on-device job says on-device, and anything else is "off"
 * (nobody is transcribing it from here, so the transcript step is skipped, never invented).
 */
export function pipelineRoute(native: NativeNote | null, hasCloudJob: boolean): PipelineRoute {
  switch (native?.transcriber ?? null) {
    case "off": return "off";
    case "on-device": return hasCloudJob ? "private-cloud" : "on-device";
    case "private-cloud":
    case "assemblyai": return "private-cloud";
    case null:
      if (hasCloudJob) return "private-cloud";
      return native?.stt != null ? "on-device" : "off";
  }
}

// --- Decision (b): the model ----------------------------------------------------------------------------------

const MODEL_PROGRESS: readonly PipelineModelState[] = ["absent", "queued", "downloading", "verifying", "checking", "ready"];

/**
 * DECISION (b): primary model and VAD readiness combine into ONE model input, "worst of the two".
 * On-device transcription needs both the RAM tier's Parakeet model and Silero VAD, and one "Get the model" action
 * fetches both (`onDeviceDownloadTotalBytes`), so the stepper has a single model. Its state is the least-ready of
 * the two (failed beats everything, then absent, queued, downloading, verifying, checking; only both ready is ready),
 * its bytes and total are the sums (so the percent is of the whole download), and its error is the failed one's.
 * `models` empty means the status has not loaded, so the model is unknown (null) and nothing is claimed. A list with
 * a primary model but no VAD entry is judged on the primary alone: the status is the only authority on what exists.
 */
export function combinedModel(status: OnDeviceSttStatus): PipelineOnDevice["model"] {
  const primaryId = status.pack === "full" ? "parakeet-tdt-0.6b-v3-int8" : "parakeet-tdt-110m-en-int8";
  const needed = status.models.filter((model) => model.id === primaryId || model.id === "silero-vad");
  if (needed.length === 0) return null;
  const failed = needed.find((model) => model.state === "failed");
  const state: PipelineModelState = failed
    ? "failed"
    : needed.reduce<PipelineModelState>(
        (least, model) => (MODEL_PROGRESS.indexOf(model.state) < MODEL_PROGRESS.indexOf(least) ? model.state : least),
        "ready",
      );
  return {
    state,
    bytes: needed.reduce((sum, model) => sum + model.bytes, 0),
    totalBytes: needed.reduce((sum, model) => sum + model.totalBytes, 0),
    error: failed?.error ?? null,
  };
}

// --- Decision (a): notes "synced" -----------------------------------------------------------------------------

/**
 * DECISION (a): the notes step is "synced" only on POSITIVE evidence, never on the absence of an error. Evidence is
 * either of:
 *   1. the space row's note pointer matches this device's revision: `note_kv_key` is this note's key and
 *      `note_edited_at` equals the local note's `editedAt` (the same test `syncRecordingNote` makes), or
 *   2. the last `syncRecordingNote` for this note succeeded for exactly the revision that is local now
 *      (`recordingNoteSyncedAt` equals `editedAt`), which covers the moment before the row is read again.
 * A note with nothing written locally, whose row carries a note pointer (written on another device), has nothing to
 * send and is synced by the row alone. Without evidence the answer is a running sync, a failed sync, a skip, or
 * "idle" (not started); an edit after the last sync changes `editedAt`, so it correctly stops being synced.
 */
export function notesSyncState(facts: Pick<NotePipelineFacts, "id" | "saved" | "rowMetadata" | "localNote" | "noteSync">): PipelineNotesSync {
  const { id, rowMetadata, localNote, noteSync } = facts;
  const rowKey = typeof rowMetadata?.note_kv_key === "string" ? rowMetadata.note_kv_key : null;
  const rowEditedAt = typeof rowMetadata?.note_edited_at === "string" ? rowMetadata.note_edited_at : null;
  if (localNote === null) return rowKey !== null ? { state: "synced" } : { state: "skipped", reason: "no-note" };
  const rowMatches = rowKey === voiceNoteMarkdownKvKey(id) && rowEditedAt === localNote.editedAt;
  if (rowMatches || noteSync.syncedAt === localNote.editedAt) return { state: "synced" };
  if (noteSync.syncing) return { state: "syncing" };
  if (noteSync.failed) return { state: "failed" };
  if (noteSync.skip !== null) return { state: "skipped", reason: noteSync.skip };
  return { state: "idle" };
}

// --- The input --------------------------------------------------------------------------------------------------

const CAPTURE_ISSUE: Record<RecorderCaptureIssue["kind"], PipelineCaptureIssue> = {
  finalization_timed_out: "finalization_timed_out",
  recoveryFailed: "recoveryFailed",
  write_failed: "write_failed",
  partial_audio: "partial_audio",
};

function onDeviceInput(facts: NotePipelineFacts): PipelineOnDevice | null {
  const status = facts.onDeviceStatus;
  if (status === null) return null;
  const place = onDeviceQueuePlace(status, facts.id);
  // The live queue entry is the newest word on the job; the ledger read is what is left after a restart.
  const stt = place !== null ? { state: place.entry.state, error: place.entry.error } : facts.native?.stt != null ? { state: facts.native.stt.state, error: facts.native.stt.error } : null;
  return {
    stt,
    queue: place === null ? null : { position: place.position, inLine: place.inLine, percent: place.percent },
    model: combinedModel(status),
    download: status.download.state,
    sync: facts.transcriptSync,
  };
}

export function buildNotePipelineInput(facts: NotePipelineFacts): NotePipelineInput {
  const route = pipelineRoute(facts.native, facts.cloudJob !== null);
  const outcome = facts.rowMetadata === null ? "none" : voiceNoteTranscriptState(facts.rowMetadata).status;
  const hasNotesOrMoments = facts.localNote?.hasContent === true || typeof facts.rowMetadata?.note_kv_key === "string";
  return {
    device: facts.device,
    route,
    hasNotesOrMoments,
    online: facts.online,
    capture: { finalizing: facts.capture.finalizing, issue: facts.capture.issue === null ? null : CAPTURE_ISSUE[facts.capture.issue.kind] },
    space: {
      saved: facts.saved,
      pending: facts.pending === null ? null : {
        ...(facts.pending.upload ? { upload: facts.pending.upload } : {}),
        ...(facts.pending.failed ? { failed: facts.pending.failed } : {}),
        ...(facts.pending.held ? { held: facts.pending.held } : {}),
        ...(facts.pending.waitingBehind !== undefined ? { waitingBehind: facts.pending.waitingBehind } : {}),
      },
      lane: facts.lane,
    },
    transcript: {
      inSpace: outcome === "none" ? null : outcome,
      onDevice: route === "on-device" ? onDeviceInput(facts) : null,
      cloud: route === "private-cloud" ? facts.cloudJob : null,
    },
    notes: notesSyncState(facts),
  };
}

// --- Actions ----------------------------------------------------------------------------------------------------

/** What the transcript step's "Try again" means right now: write the transcript again, fetch the model, or transcribe again. */
export function transcriptRetryTarget(input: NotePipelineInput): "private-cloud" | "sync" | "model" | "note" {
  if (input.route === "private-cloud") return "private-cloud";
  const od = input.transcript.onDevice;
  if (od?.sync?.state === "failed") return "sync";
  if (od !== null && (od.stt === null || od.stt.state === "waiting_for_model")) return "model";
  return "note";
}

export interface PipelineActionEnv {
  id: string;
  tcw: TinyCloudWeb | null;
  pipeline: NotePipeline;
  input: NotePipelineInput;
  transcription: VoiceNoteTranscriptionProps | undefined;
  /** The existing Save now / recovery trigger (`recorder.retryPending`). */
  saveNow: () => void;
  /** The app's sign-in entry; absent where there is none. */
  signIn: (() => void | Promise<void>) | null;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs the blocker's action with the existing function behind it. The reason it did not work, or null. Nothing is swallowed. */
export async function runPipelineAction(kind: PipelineActionKind, env: PipelineActionEnv): Promise<string | null> {
  try {
    switch (kind) {
      case "sign-in":
        if (env.signIn === null) return "Signing in isn't available here.";
        await env.signIn();
        return null;
      case "get-model":
        return await downloadOnDeviceModel();
      case "check-again":
        if (!env.transcription) return "Private transcription isn't available here.";
        await env.transcription.onRecheck();
        return null;
      case "retry":
        switch (env.pipeline.current) {
          case "space":
            env.saveNow();
            return null;
          case "notes":
            if (env.tcw === null) return "Sign in to sync this note.";
            await syncRecordingNote(env.tcw, env.id);
            return null;
          case "transcript":
            switch (transcriptRetryTarget(env.input)) {
              case "private-cloud":
                if (!env.transcription) return "Private transcription isn't available here.";
                env.transcription.onTranscribe(env.id);
                return null;
              case "sync":
                if (env.tcw === null) return "Sign in to add the transcript to this note.";
                await syncOnDeviceTranscript(env.tcw, { id: env.id, ledger: { audio: { state: "saved" } } });
                return null;
              case "model":
                return await downloadOnDeviceModel();
              case "note":
                return await retryOnDeviceNote(env.id);
            }
          // falls through only if `current` is a step with no retry
          case "phone":
          case null:
            return "There is nothing to try again for this step.";
        }
    }
  } catch (caught) {
    console.error("[NotePipeline] action failed", kind, env.id, caught);
    return messageOf(caught);
  }
}

// --- Hooks ------------------------------------------------------------------------------------------------------

/** A number that changes whenever `subscribe`'s store notifies; for stores that only expose per-key getters. */
function useStoreVersion(subscribe: (listener: () => void) => () => void): number {
  const version = useRef(0);
  const subscribeCounting = useCallback(
    (listener: () => void) => subscribe(() => { version.current += 1; listener(); }),
    [subscribe],
  );
  return useSyncExternalStore(subscribeCounting, () => version.current, () => version.current);
}

/**
 * The notes' native ledger entries, read once per list of ids and again when the plugin says a job ended. `ready`
 * is false until the first read has answered: the route (and so the whole transcript step) depends on it. A read
 * that fails is logged and counts as answered with nothing found, so the pipeline still shows.
 */
function useNativeNotes(ids: readonly string[], enabled: boolean): { ready: boolean; notes: ReadonlyMap<string, NativeNote> } {
  const key = ids.join("\n");
  const needed = enabled && ids.length > 0 && nativeVoiceNotesAvailable();
  const [read, setRead] = useState<{ key: string; notes: ReadonlyMap<string, NativeNote> }>({ key: "", notes: new Map() });
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    const load = () => {
      VoiceNotes.listPending().then(
        ({ recordings }) => {
          if (!alive) return;
          const next = new Map<string, NativeNote>();
          for (const id of ids) {
            const found = recordings.find((recording) => recording.id === id);
            if (found) next.set(id, { transcriber: (found.options?.transcriber as TranscriberId | undefined) ?? null, stt: found.stt ?? null });
          }
          setRead({ key, notes: next });
        },
        (caught: unknown) => {
          console.error("[NotePipeline] Could not read the phone's note ledger", caught);
          if (alive) setRead((previous) => ({ key, notes: previous.notes }));
        },
      );
    };
    load();
    const subs = localTranscriptionUnavailable() ? [] : [
      OnDeviceStt.addListener("transcribed", (event) => { if (ids.includes(event.id)) load(); }),
      OnDeviceStt.addListener("failed", (event) => { if (ids.includes(event.id)) load(); }),
    ];
    for (const sub of subs) sub.catch((caught: unknown) => console.error("[NotePipeline] Could not follow on-device transcription", caught));
    return () => {
      alive = false;
      for (const sub of subs) sub.then((handle) => handle.remove()).catch(() => {});
    };
    // `ids` is keyed by its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needed]);
  return { ready: !needed || read.key === key, notes: read.notes };
}

/** Each note's local Markdown, read again whenever a note sync finishes (an edit syncs after it is written). */
function useLocalNotes(ids: readonly string[], reread: unknown): ReadonlyMap<string, LocalNoteFacts | null> {
  const [notes, setNotes] = useState<ReadonlyMap<string, LocalNoteFacts | null>>(new Map());
  const key = ids.join("\n");
  useEffect(() => {
    let alive = true;
    Promise.all(
      ids.map(async (id): Promise<[string, LocalNoteFacts | null]> => {
        try {
          const note = await loadNote(id);
          return [id, note === null ? null : { editedAt: note.editedAt, hasContent: note.md.trim().length > 0 || note.moments.length > 0 }];
        } catch (caught) {
          console.error("[NotePipeline] Could not read the local note", id, caught);
          return [id, null];
        }
      }),
    ).then((entries) => { if (alive) setNotes(new Map(entries)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reread]);
  return notes;
}

export interface NotePipelineSource {
  tcw: TinyCloudWeb | null;
  /** The note is a row in the space (not the phone-only stand-in, nor a receipt that has not saved yet). */
  saved: boolean;
  /** The space row's metadata; null before it is read or when the note has no row. */
  metadata: Record<string, unknown> | null;
  /** A caller that already read the phone's ledger for this note (the receipt) hands it over, so it is not read twice. */
  native?: NativeNote | null;
}

export interface NotePipelineView {
  pipeline: NotePipeline;
  /** Runs the blocker's action; its failure shows as `actionError`. */
  onAction: (kind: PipelineActionKind) => void;
  actionError: string | null;
}

interface PipelineState { input: NotePipelineInput; pipeline: NotePipeline }

/** Each note's input and pipeline, off one set of subscriptions. Notes the local Markdown read has not answered for are left out. */
function usePipelineStates(entries: readonly { id: string; source: NotePipelineSource }[]): ReadonlyMap<string, PipelineState> {
  const recorder = useRecorder();
  const platform = useContext(PlatformContext);
  const ids = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.snapshot, pendingStore.snapshot);
  const laneBusy = useSyncExternalStore(subscribeSpaceLane, () => spaceLaneSnapshot().busy, () => false);
  const onDeviceStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const syncVersion = useStoreVersion(subscribeRecordingNoteSync);
  const transcriptSyncVersion = useStoreVersion(subscribeOnDeviceTranscriptSync);
  const nativeRead = useNativeNotes(ids, entries.some((entry) => entry.source.native === undefined));
  const natives = nativeRead.notes;
  const locals = useLocalNotes(ids, syncVersion);
  const device: PipelineDevice = platform === "tauri" ? "mac" : "phone";
  const hasOnDevice = !localTranscriptionUnavailable() && nativeVoiceNotesAvailable();
  return useMemo(() => {
    const out = new Map<string, PipelineState>();
    for (const { id, source } of entries) {
      if (!locals.has(id) || !nativeRead.ready) continue;
      const issue = recorder.captureIssues[id] ?? null;
      const tcw = source.tcw;
      const input = buildNotePipelineInput({
        id,
        device,
        online: pending.online,
        saved: source.saved,
        rowMetadata: source.metadata,
        localNote: locals.get(id) ?? null,
        native: source.native !== undefined ? source.native : natives.get(id) ?? null,
        capture: { finalizing: recorder.finalizationPendingId === id && issue === null, issue },
        pending: pending.notes?.find((note) => note.id === id) ?? null,
        lane: { busy: laneBusy, depth: spaceLaneSnapshot().depth },
        onDeviceStatus: hasOnDevice ? onDeviceStatus : null,
        transcriptSync: tcw === null ? null : onDeviceTranscriptSyncState(tcw, id),
        cloudJob: recorder.transcription?.jobs.get(id) ?? null,
        noteSync: tcw === null
          ? { syncing: false, failed: false, skip: null, syncedAt: null }
          : { syncing: recordingNoteSyncing(tcw, id), failed: recordingNoteSyncError(tcw, id) !== null, skip: recordingNoteSyncSkip(tcw, id), syncedAt: recordingNoteSyncedAt(tcw, id) },
      });
      out.set(id, { input, pipeline: notePipeline(input) });
    }
    return out;
    // The store versions say the per-key getters read above have new answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, locals, natives, nativeRead.ready, pending, laneBusy, onDeviceStatus, recorder.captureIssues, recorder.finalizationPendingId, recorder.transcription, device, hasOnDevice, syncVersion, transcriptSyncVersion]);
}

/** Several notes' pipelines at once. A note is absent until its local Markdown and the phone's ledger have been read. */
export function useNotePipelines(entries: readonly { id: string; source: NotePipelineSource }[]): ReadonlyMap<string, NotePipeline> {
  const states = usePipelineStates(entries);
  return useMemo(() => new Map([...states].map(([id, state]) => [id, state.pipeline])), [states]);
}

/**
 * One note's pipeline and its action. Null until the note's local Markdown and the phone's ledger have been read (the notes
 * step and the route depend on them, so a stepper shown earlier would flash steps in or out).
 */
export function useNotePipeline(id: string | null, source: NotePipelineSource): NotePipelineView | null {
  const recorder = useRecorder();
  const entries = useMemo(() => (id === null ? [] : [{ id, source }]), [id, source]);
  const states = usePipelineStates(entries);
  const state = id === null ? null : states.get(id) ?? null;
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const latest = useRef({ state, source, recorder });
  latest.current = { state, source, recorder };
  const onAction = useCallback((kind: PipelineActionKind) => {
    const { state: current, source: from, recorder: rec } = latest.current;
    if (current === null || id === null) return;
    setFailure(null);
    void runPipelineAction(kind, {
      id,
      tcw: from.tcw,
      pipeline: current.pipeline,
      input: current.input,
      transcription: rec.transcription,
      saveNow: rec.retryPending,
      signIn: rec.signIn,
    }).then((reason) => { if (live.current) setFailure(reason); });
  }, [id]);
  if (state === null) return null;
  return { pipeline: state.pipeline, onAction, actionError: state.pipeline.blocker === undefined ? null : failure };
}
