// One pure selector from everything the app knows about a note to the four-step picture of where it is:
// on this phone -> in your space -> transcript -> notes. The surfaces (stepper, row halo, In progress card)
// render this and nothing else. `NotePipelineInput` mirrors, structurally, the signals the stores publish; the
// wiring that fills it from the stores is separate.
import {
  ACTION_LABEL,
  LOCAL_COPY,
  NOTES_COPY,
  PHONE_COPY,
  PRIVATE_COPY,
  SPACE_COPY,
  STEP_LABEL,
} from "./notePipelineCopy";

export type PipelineDevice = "phone" | "mac";
export type PipelineRoute = "off" | "on-device" | "private-cloud";
export type StepKey = "phone" | "space" | "transcript" | "notes";
export type StepState = "done" | "active" | "waiting" | "blocked" | "failed" | "upcoming" | "skipped";
/** `reread`: read again what failed to read (it belongs to no one step). */
export type PipelineActionKind = "sign-in" | "retry" | "get-model" | "check-again" | "reread";

// --- Input: mirrors of the signals --------------------------------------------------------------------------

/** The recorder's capture issues for this recording (`RecorderCaptureIssue` kinds, plus a quarantined session). */
export type PipelineCaptureIssue = "finalization_timed_out" | "recoveryFailed" | "quarantined" | "write_failed" | "partial_audio";

/**
 * `PendingNote.failed.kind` (P1). `source` (P1 revision, design §9): the audio could not be read, is too large or is
 * corrupt. It is not retryable, so it carries no action. `other` is an unclassified error and stays retryable.
 */
export type PipelineFailureKind = "offline" | "timeout" | "quota" | "auth" | "server" | "source" | "other";
/** `PendingNote.held` (P1; `SaveOutcome.held.reason` plus signed-out). */
export type PipelineHeldReason = "signed-out" | "other-account" | "legacy" | "unowned";

/** The part of `PendingNote` (P1) the pipeline reads. A note with no pending entry and no space row yet has `pending: null`. */
export interface PipelinePending {
  upload?: { state: "waiting" | "uploading" | "retrying"; bytes: number; total: number };
  failed?: { kind: PipelineFailureKind; message: string };
  held?: PipelineHeldReason;
  /** Per note: how many notes are ahead of this one in the save queue (0 = next). This is the only queue position. */
  waitingBehind?: number;
}

/**
 * `spaceLaneSnapshot()` (P1): the global write lane. `busy`: a job is running or queued. `depth`: every queued job,
 * including this note and the ones behind it, so it is NOT a position and is never shown. Only `busy` is read.
 */
export interface PipelineSpaceLane { busy: boolean; depth: number }

/** `NoteSttState["state"]`. */
export type PipelineSttState = "waiting_for_model" | "queued" | "running" | "done" | "failed" | "cancelled";
/** `OnDeviceSttStatus["models"][number]["state"]`. */
export type PipelineModelState = "absent" | "queued" | "downloading" | "verifying" | "checking" | "ready" | "failed";
/** `OnDeviceSttStatus["download"]["state"]`. */
export type PipelineDownloadState = "idle" | "running" | "waiting_for_network" | "low_data_mode" | "failed";

/** `OnDeviceTranscriptSyncState` (P2): the local transcript's write onto the space row. */
export type PipelineTranscriptSync = { state: "syncing" } | { state: "synced" } | { state: "failed"; message: string };

export interface PipelineOnDevice {
  /** This note's native queue job; null when native has no job for it. */
  stt: { state: PipelineSttState; error: string | null } | null;
  /** `onDeviceQueuePlace` (P2): its place in line and the running job's percent (0..100). */
  queue: { position: number | null; inLine: number; percent: number | null } | null;
  /** The model this phone needs, as `onDeviceSttStore` reports it; null when not known. */
  model: { state: PipelineModelState; bytes: number; totalBytes: number; error: string | null } | null;
  download: PipelineDownloadState;
  sync: PipelineTranscriptSync | null;
}

/** `TranscriptionBlockedReason` (P2). */
export type PipelineBlockedReason = "checking" | "unavailable" | "check-failed" | "no-consent" | "hidden";

/** `VoiceNoteTranscriptionStatus` (`waiting.position` is P2). */
export type PipelineCloudStatus =
  | { kind: "waiting"; position: number }
  | { kind: "preparing" }
  | { kind: "uploading" }
  | { kind: "queued"; position: number | null }
  | { kind: "processing"; completed: number | null; total: number | null }
  | { kind: "saving" };

/** `NoteTranscriptionState` (`blocked` is P2). */
export type PipelineCloud =
  | { kind: "active"; status: PipelineCloudStatus }
  | { kind: "done"; outcome: "transcribed" | "no_speech" }
  | { kind: "failed"; code: string; message: string; retryable: boolean; reference: string | null }
  | { kind: "held"; message: string }
  | { kind: "blocked"; reason: PipelineBlockedReason };

/** Note sync (`syncRecordingNote`, `recordingNoteSyncError/Syncing/Skip`). `idle`: not synced and no sync running; nothing has started one. */
export type PipelineNotesSync =
  | { state: "idle" }
  | { state: "syncing" }
  | { state: "synced" }
  | { state: "failed" }
  | { state: "skipped"; reason: "no-row" | "no-note" }
  /** The note's local text could not be read, so nothing is known about its sync. `cause` is the read's own error. */
  | { state: "unreadable"; cause: string };

export interface NotePipelineInput {
  device: PipelineDevice;
  route: PipelineRoute;
  /** The note has written notes or moments, so "Notes" is a step. */
  hasNotesOrMoments: boolean;
  online: boolean;
  /** `readError`: the list of recordings that failed to save could not be read (the read's own error); a quarantined session could be missing. */
  capture: { finalizing: boolean; issue: PipelineCaptureIssue | null; readError?: string | null };
  space: { saved: boolean; pending: PipelinePending | null; lane: PipelineSpaceLane };
  transcript: {
    /** The space row already has a transcript outcome. */
    inSpace: "transcribed" | "no_speech" | null;
    onDevice: PipelineOnDevice | null;
    cloud: PipelineCloud | null;
    /**
     * Reading what decides this step failed (the phone's note ledger, its on-device listeners, the space row): the
     * read's own error. The route and the transcript are unknown then, never "absent" or "ready".
     */
    readError?: string | null;
    /** The space row has not been read yet (it queues behind uploads on the write lane): what only it can say is not known. */
    spaceReading?: boolean;
  };
  notes: PipelineNotesSync;
}

// --- Output ---------------------------------------------------------------------------------------------------

export interface PipelineStep {
  key: StepKey;
  label: string;
  state: StepState;
  /** Why this step is blocked or failed, and its action. Every blocked or failed step has one. */
  blocker?: PipelineBlocker;
  /** What this step is doing now, for the surfaces to show when it is the current step. */
  caption?: string;
  /** 0..1 for an active step that knows how far along it is. */
  progress?: number;
  /** A note under a step that is done ahead of its turn ("Ready on this phone"). */
  sublabel?: string;
}

export interface PipelineBlocker {
  cause: string;
  action?: { kind: PipelineActionKind; label: string };
}

export interface NotePipeline {
  steps: PipelineStep[];
  /** The step to show a caption and blocker for; null when everything is done. */
  current: StepKey | null;
  done: boolean;
  /** The one blocker to show: the blocker of `current`, chosen by action priority across all stuck steps. */
  blocker?: PipelineBlocker;
  /** Information that is not a problem and not a step ("part of this recording couldn't be written"). */
  notice?: string;
}

/** Which action wins when several notes are stuck: sign-in > get-model > retry > check-again. Higher wins; no action is 0. */
export function pipelineActionPriority(kind: PipelineActionKind | undefined): number {
  switch (kind) {
    case "sign-in": return 4;
    case "get-model": return 3;
    case "retry": return 2;
    case "check-again": return 1;
    case "reread": return 0;
    case undefined: return 0;
  }
}

// --- Selector -------------------------------------------------------------------------------------------------

type Result = Omit<PipelineStep, "key" | "label">;

const block = (cause: string, kind?: PipelineActionKind): PipelineBlocker =>
  kind === undefined ? { cause } : { cause, action: { kind, label: ACTION_LABEL[kind] } };
const blocked = (cause: string, kind?: PipelineActionKind): Result => ({ state: "blocked", blocker: block(cause, kind) });
const failed = (cause: string, kind?: PipelineActionKind): Result => ({ state: "failed", blocker: block(cause, kind) });
const fraction = (done: number, total: number): number | null => (total > 0 && Number.isFinite(done) ? Math.min(1, Math.max(0, done / total)) : null);
const withProgress = (state: "active" | "waiting", caption: string, progress: number | null): Result =>
  progress === null ? { state, caption } : { state, caption, progress };

function phoneStep(input: NotePipelineInput): Result {
  const { finalizing, issue } = input.capture;
  switch (issue) {
    case "finalization_timed_out": return blocked(PHONE_COPY.timedOut);
    case "recoveryFailed":
    case "quarantined": return failed(PHONE_COPY.recoveryFailed);
    case "write_failed": return failed(PHONE_COPY.writeFailed(null));
    case "partial_audio":
    case null: break;
  }
  if (finalizing) return { state: "active", caption: PHONE_COPY.finishing };
  return { state: "done" };
}

function spaceStep(input: NotePipelineInput): Result {
  if (input.space.saved) return { state: "done" };
  const { device, online } = input;
  const pending = input.space.pending;
  if (pending?.held !== undefined) {
    switch (pending.held) {
      case "signed-out": return blocked(SPACE_COPY.signedOut(device), "sign-in");
      case "other-account": return blocked(SPACE_COPY.otherAccount);
      case "legacy":
      case "unowned": return blocked(SPACE_COPY.accountUnknown(device));
    }
  }
  const failure = pending?.failed;
  if (failure !== undefined) {
    switch (failure.kind) {
      case "auth": return blocked(SPACE_COPY.sessionExpired(device), "sign-in");
      case "quota": return blocked(SPACE_COPY.quota);
      case "offline":
        if (!online) return { state: "waiting", caption: SPACE_COPY.offlineCaption };
        return failed(SPACE_COPY.unreachable(device), "retry");
      case "timeout": return failed(SPACE_COPY.timeout(device), "retry");
      case "server": return failed(SPACE_COPY.server(failure.message, device), "retry");
      case "source": return failed(SPACE_COPY.source(failure.message));
      case "other": return failed(SPACE_COPY.unknown(failure.message), "retry");
    }
  }
  if (!online) return { state: "waiting", caption: SPACE_COPY.offlineCaption };
  const upload = pending?.upload;
  if (upload?.state === "uploading") {
    return withProgress("active", SPACE_COPY.uploading(fraction(upload.bytes, upload.total)), fraction(upload.bytes, upload.total));
  }
  if (upload?.state === "retrying") return withProgress("active", SPACE_COPY.retrying, fraction(upload.bytes, upload.total));
  const ahead = pending?.waitingBehind;
  if (ahead !== undefined && (ahead > 0 || input.space.lane.busy)) return { state: "waiting", caption: SPACE_COPY.waitingInLine(ahead + 1) };
  return { state: "waiting", caption: SPACE_COPY.waiting };
}

/** The model a Local note waits on: null once nothing about the model stands in the way. */
function modelStep(od: PipelineOnDevice, device: PipelineDevice): Result | null {
  const { model, download } = od;
  if (download === "failed" || model?.state === "failed") return failed(LOCAL_COPY.modelFailed(model?.error), "retry");
  if (download === "waiting_for_network") return { state: "waiting", caption: LOCAL_COPY.waitingForWifi };
  if (download === "low_data_mode") return { state: "waiting", caption: LOCAL_COPY.lowDataMode };
  if (model === null) return null;
  switch (model.state) {
    case "absent":
      if (download === "idle") return blocked(LOCAL_COPY.needsModel(device), "get-model");
      return { state: "active", caption: LOCAL_COPY.waitingForModel(null) };
    case "queued":
    case "downloading": {
      const progress = fraction(model.bytes, model.totalBytes);
      return withProgress("active", LOCAL_COPY.waitingForModel(progress), progress);
    }
    case "verifying":
    case "checking": return { state: "active", caption: LOCAL_COPY.verifyingModel };
    case "ready": return null;
  }
}

function onDeviceStep(input: NotePipelineInput, od: PipelineOnDevice): Result {
  const saved = input.space.saved;
  const { sync, stt, queue } = od;
  if (sync?.state === "failed") return failed(LOCAL_COPY.syncFailed(sync.message), "retry");
  if (sync?.state === "syncing") return { state: "active", caption: LOCAL_COPY.adding };
  if (sync?.state === "synced") return { state: "done" };
  if (stt === null) {
    const model = modelStep(od, input.device);
    if (model !== null) return model;
    return saved ? { state: "waiting", caption: LOCAL_COPY.notStarted } : { state: "upcoming" };
  }
  switch (stt.state) {
    case "done":
      if (!saved) return { state: "done", sublabel: LOCAL_COPY.readyOnDevice(input.device) };
      // Nothing is adding it (`sync` is null) and the space has no transcript: an attempt that never ran is a blocker, never "adding".
      return input.transcript.spaceReading === true ? { state: "waiting", caption: LOCAL_COPY.checkingSpace } : blocked(LOCAL_COPY.notAdded, "retry");
    case "failed": return failed(LOCAL_COPY.failed(stt.error, input.device), "retry");
    case "cancelled": return blocked(LOCAL_COPY.cancelled(input.device), "retry");
    case "running": {
      const progress = queue?.percent == null ? null : Math.min(1, Math.max(0, queue.percent / 100));
      return withProgress("active", LOCAL_COPY.transcribing(progress), progress);
    }
    case "queued": return { state: "waiting", caption: LOCAL_COPY.queued(queue?.position ?? null) };
    case "waiting_for_model": return modelStep(od, input.device) ?? { state: "waiting", caption: LOCAL_COPY.queued(queue?.position ?? null) };
  }
}

function cloudBlockedStep(reason: PipelineBlockedReason): Result {
  switch (reason) {
    case "checking": return { state: "waiting", caption: PRIVATE_COPY.checking };
    case "unavailable": return blocked(PRIVATE_COPY.unavailable, "check-again");
    case "check-failed": return blocked(PRIVATE_COPY.checkFailed, "check-again");
    case "no-consent": return blocked(PRIVATE_COPY.noConsent);
    case "hidden": return blocked(PRIVATE_COPY.hidden);
  }
}

function cloudStep(cloud: PipelineCloud | null, spaceSaved: boolean, spaceReading: boolean): Result {
  if (!spaceSaved) return { state: "upcoming" };
  if (cloud === null) return { state: "waiting", caption: spaceReading ? LOCAL_COPY.checkingSpace : PRIVATE_COPY.notStarted };
  switch (cloud.kind) {
    case "done": return cloud.outcome === "no_speech" ? { state: "done", caption: PRIVATE_COPY.noSpeech } : { state: "done" };
    case "held": return blocked(cloud.message.trim() || PRIVATE_COPY.notStarted);
    case "failed":
      return failed(PRIVATE_COPY.failed(cloud.message, cloud.retryable ? null : cloud.reference), cloud.retryable ? "retry" : undefined);
    case "blocked": return cloudBlockedStep(cloud.reason);
    case "active": {
      const status = cloud.status;
      switch (status.kind) {
        case "waiting": return { state: "waiting", caption: PRIVATE_COPY.waiting(status.position) };
        case "preparing": return { state: "active", caption: PRIVATE_COPY.preparing };
        case "uploading": return { state: "active", caption: PRIVATE_COPY.sending };
        case "queued": return { state: "waiting", caption: PRIVATE_COPY.inQueue(status.position) };
        case "processing": {
          const progress = status.completed === null || status.total === null ? null : fraction(status.completed, status.total);
          return withProgress("active", PRIVATE_COPY.transcribing(status.completed, status.total), progress);
        }
        case "saving": return { state: "active", caption: PRIVATE_COPY.saving };
      }
    }
  }
}

function transcriptStep(input: NotePipelineInput): Result {
  const { inSpace, onDevice, cloud } = input.transcript;
  if (input.route === "private-cloud" && !input.space.saved) return { state: "upcoming" };
  if (inSpace !== null) return inSpace === "no_speech" ? { state: "done", caption: LOCAL_COPY.noSpeech } : { state: "done" };
  if (input.route === "private-cloud") return cloudStep(cloud, input.space.saved, input.transcript.spaceReading === true);
  if (onDevice === null) return input.space.saved ? { state: "waiting", caption: input.transcript.spaceReading === true ? LOCAL_COPY.checkingSpace : LOCAL_COPY.notStarted } : { state: "upcoming" };
  return onDeviceStep(input, onDevice);
}

function notesStep(input: NotePipelineInput, transcript: StepState): Result {
  const sync = input.notes;
  if (sync.state === "synced") return { state: "done" };
  if (sync.state === "unreadable") return failed(NOTES_COPY.unreadable(sync.cause), "retry");
  if (!input.space.saved) return { state: "upcoming" };
  switch (sync.state) {
    case "syncing": return { state: "active", caption: NOTES_COPY.syncing };
    case "failed": return failed(NOTES_COPY.failed, "retry");
    case "skipped": return sync.reason === "no-note" ? { state: "skipped" } : { state: "waiting", caption: NOTES_COPY.waitingForRow };
    // Nothing has started the sync. Behind a transcript that is still running or needs you, it is not its turn: that step owns the blocker.
    case "idle": return (transcript === "done" || transcript === "skipped") && input.transcript.spaceReading !== true ? blocked(NOTES_COPY.notSynced, "retry") : { state: "upcoming" };
  }
}

const UNREACHED: Result = { state: "upcoming" };
const needsYou = (state: StepState) => state === "blocked" || state === "failed";

export function notePipeline(input: NotePipelineInput): NotePipeline {
  const phone = phoneStep(input);
  const phoneDone = phone.state === "done";
  const space = phoneDone ? spaceStep(input) : UNREACHED;
  const { readError, inSpace } = input.transcript;
  // A failed read leaves the route unknown: with no transcript in the space that is a failure, with one the transcript is done (and the failure is shown below).
  const transcript: Result = readError != null && inSpace === null
    ? phoneDone ? failed(LOCAL_COPY.readFailed(readError), "retry") : UNREACHED
    : input.route === "off" && readError == null ? { state: "skipped" } : phoneDone ? transcriptStep(input) : UNREACHED;
  const notes: Result = !input.hasNotesOrMoments && input.notes.state !== "unreadable" ? { state: "skipped" } : phoneDone ? notesStep(input, transcript.state) : UNREACHED;

  const results: [StepKey, string, Result][] = [
    ["phone", STEP_LABEL.phone(input.device), phone],
    ["space", STEP_LABEL.space, space],
    ["transcript", STEP_LABEL.transcript, transcript],
    ["notes", STEP_LABEL.notes, notes],
  ];
  const steps: PipelineStep[] = results.map(([key, label, result]) => {
    const step: PipelineStep = { key, label, state: result.state };
    if (result.blocker !== undefined) step.blocker = result.blocker;
    if (result.caption !== undefined) step.caption = result.caption;
    if (result.progress !== undefined) step.progress = result.progress;
    if (result.sublabel !== undefined) step.sublabel = result.sublabel;
    return step;
  });

  const live = results.filter(([, , result]) => result.state !== "skipped");
  const done = live.every(([, , result]) => result.state === "done");

  let current: StepKey | null = null;
  let blocker: PipelineBlocker | undefined;
  if (!done) {
    let best = -1;
    for (const [key, , result] of live) {
      if (!needsYou(result.state) || result.blocker === undefined) continue;
      const priority = pipelineActionPriority(result.blocker.action?.kind);
      if (priority > best) {
        best = priority;
        current = key;
        blocker = result.blocker;
      }
    }
    current ??= live.find(([, , result]) => result.state === "active")?.[0] ?? live.find(([, , result]) => result.state !== "done")?.[0] ?? null;
  }

  // A read that failed is never dropped because other evidence already settles a step: it is shown, and the note is not "done" until it reads.
  const failedReads = [
    input.capture.readError == null ? null : PHONE_COPY.quarantineReadFailed(input.capture.readError),
    readError != null && inSpace !== null ? LOCAL_COPY.otherReadFailed(readError) : null,
  ].filter((cause): cause is string => cause !== null);
  const unread = failedReads.length > 0;
  const notices = input.capture.issue === "partial_audio" ? [PHONE_COPY.partialAudio] : [];
  if (unread && blocker === undefined) blocker = block(failedReads.join(" "), "reread");
  else if (unread) notices.push(...failedReads);

  const pipeline: NotePipeline = { steps, current, done: done && !unread };
  if (blocker !== undefined) pipeline.blocker = blocker;
  if (notices.length > 0) pipeline.notice = notices.join(" ");
  return pipeline;
}
