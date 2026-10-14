// One pure selector from everything the app knows about a note to its independent audio and transcript tracks.
// The surfaces (stepper, track summary, In progress card)
// render this and nothing else. `NotePipelineInput` mirrors, structurally, the signals the stores publish; the
// wiring that fills it from the stores is separate.
import {
  ACTION_LABEL,
  LOCAL_COPY,
  NOTES_COPY,
  PHONE_COPY,
  PRIVATE_COPY,
  SPACE_COPY,
  TRANSCRIPT_COPY,
  STEP_LABEL,
  deviceName,
  percentText,
} from "./notePipelineCopy";

export type PipelineDevice = "phone" | "mac" | "iphone" | "android" | "browser";
export type PipelineRoute = "off" | "on-device" | "private-cloud";
export type StepKey = "phone" | "space" | "transcript" | "notes";
export type StepState = "done" | "active" | "waiting" | "blocked" | "failed" | "upcoming" | "skipped";
/** `reread`: read again what failed to read (it belongs to no one step). */
export type PipelineActionKind = "sign-in" | "retry" | "get-model" | "check-again" | "reread" | "review-consent" | "manage-storage";

// --- Input: mirrors of the signals --------------------------------------------------------------------------

/** The recorder's capture issues for this recording (`RecorderCaptureIssue` kinds, plus a quarantined session). */
export type PipelineCaptureIssue = "finalization_timed_out" | "recoveryFailed" | "quarantined" | "write_failed" | "partial_audio";

/**
 * `PendingNote.failed.kind` (P1). `source` (P1 revision, design §9): the audio could not be read, is too large or is
 * corrupt. It is not retryable, so it carries no action. `other` is an unclassified error and stays retryable.
 */
export type PipelineFailureKind = "offline" | "rejected" | "timeout" | "quota" | "auth" | "server" | "source" | "other";
/** `PendingNote.held` (P1; `SaveOutcome.held.reason` plus signed-out). */
export type PipelineHeldReason = "signed-out" | "other-account" | "legacy" | "unowned";

/** The part of `PendingNote` (P1) the pipeline reads. A note with no pending entry and no space row yet has `pending: null`. */
export interface PipelinePending {
  upload?: { state: "waiting" | "preparing" | "uploading" | "retrying"; bytes: number; total: number };
  failed?: { kind: PipelineFailureKind; message: string };
  held?: PipelineHeldReason;
  /** The next automatic save attempt, when a slow response is being retried. */
  retryAt?: number;
  /** Per note: how many notes are ahead of this one in the save queue (0 = next). This is the only queue position. */
  waitingBehind?: number;
}

/**
 * The text lane snapshot controls space-read copy. `busy` means a text request
 * is running or queued; `depth` counts queued text requests, not a note position.
 */
export interface PipelineSpaceLane { busy: boolean; depth: number }

/** `NoteSttState["state"]`. */
export type PipelineSttState = "waiting_for_model" | "queued" | "running" | "done" | "failed" | "cancelled";
/** `OnDeviceSttStatus["models"][number]["state"]`. */
export type PipelineModelState = "absent" | "queued" | "downloading" | "verifying" | "checking" | "ready" | "failed";
/** `OnDeviceSttStatus["download"]["state"]`. */
export type PipelineDownloadState = "idle" | "running" | "waiting_for_network" | "low_data_mode" | "failed";

/** `OnDeviceTranscriptSyncState` (P2): the local transcript's write onto the space row. */
export type PipelineTranscriptSync = { state: "syncing" } | { state: "synced" } | { state: "failed"; message: string } | { state: "unrecorded"; message: string };

export interface PipelineOnDevice {
  /** This note's native queue job; null when native has no job for it. */
  stt: { state: PipelineSttState; error: string | null } | null;
  /** `onDeviceQueuePlace` (P2): its place in line and the running job's percent (0..100). */
  queue: { position: number | null; inLine: number; percent: number | null } | null;
  /** The model this phone needs, as `onDeviceSttStore` reports it; null when not known. */
  model: { state: PipelineModelState; bytes: number; totalBytes: number; error: string | null } | null;
  download: PipelineDownloadState;
  /** iOS's built-in speech (`OnDeviceSttStatus["appleSpeech"]`): there is no model to fetch, only assets the OS installs. Absent where a model is. */
  appleSpeech?: "unsupported" | "locale_unsupported" | "asset_missing" | "ready";
  sync: PipelineTranscriptSync | null;
}

/** `TranscriptionBlockedReason` (P2). */
export type PipelineBlockedReason = "checking" | "unavailable" | "check-failed" | "no-consent";

/** `VoiceNoteTranscriptionStatus` (`waiting.position` is P2). */
export type PipelineCloudStatus =
  | { kind: "waiting"; position: number }
  | { kind: "preparing" }
  | { kind: "uploading"; progress?: number }
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

export type PersistedTranscriptState = "pending" | "failed" | "skipped";

export interface NotePipelineInput {
  device: PipelineDevice;
  route: PipelineRoute;
  transcriptProvider?: "private" | "powerful" | "unknown";
  /** The note has written notes or moments, so "Notes" is a step. */
  hasNotesOrMoments: boolean;
  online: boolean;
  /** A chosen local-only recording has no space audio upload (#351). */
  audioUploadIntent?: boolean;
  /** `readError`: the list of recordings that failed to save could not be read (the read's own error); a quarantined session could be missing. */
  capture: { finalizing: boolean; issue: PipelineCaptureIssue | null; readError?: string | null };
  space: { saved: boolean; localOnly?: boolean; pending: PipelinePending | null; lane: PipelineSpaceLane };
  transcript: {
    /** The space row already has a transcript outcome. */
    inSpace: "transcribed" | "no_speech" | null;
    /** A durable non-terminal transcript state from the Library row. */
    persistedState?: PersistedTranscriptState;
    /** The row's persisted failure code, when one is present. */
    errorCode?: string | null;
    onDevice: PipelineOnDevice | null;
    cloud: PipelineCloud | null;
    /**
     * Reading what decides this step failed (the phone's note ledger, its on-device listeners, the space row): the
     * read's own error. The route and the transcript are unknown then, never "absent" or "ready".
     */
    readError?: string | null;
    /**
     * A private-cloud note, saved, with no job, and nothing about to start one (the account's check has answered): it is
     * not being transcribed and will not be unless asked, so the step is skipped, like a note committed to no transcript.
     */
    cloudIdle?: true;
    /** The space row has not been read yet (it queues behind uploads on the write lane): what only it can say is not known. */
    spaceReading?: boolean;
    /** With `spaceReading`: uploads are ahead of that read in the write lane. */
    afterUploads?: boolean;
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
  /** The action transcribes the note again, so a surface that can offer the user's choice of provider shows that in its place. */
  chooseProvider?: true;
}

export interface NotePipeline {
  steps: PipelineStep[];
  /** The step to show a caption and blocker for; null when everything is done. */
  current: StepKey | null;
  done: boolean;
  /** Durable row state to show when the live transcript step is otherwise skipped. */
  transcriptionState?: PersistedTranscriptState;
  transcriptionErrorCode?: string | null;
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
    case "manage-storage": return 2;
    case "check-again": return 1;
    case "review-consent": return 1;
    case "reread": return 0;
    case undefined: return 0;
  }
}

// --- Selector -------------------------------------------------------------------------------------------------

type Result = Omit<PipelineStep, "key" | "label">;

const checking = (transcript: NotePipelineInput["transcript"]): string => (transcript.afterUploads === true ? LOCAL_COPY.checkingSpaceAfterUploads : LOCAL_COPY.checkingSpace);
const block = (cause: string, kind?: PipelineActionKind, chooseProvider = false): PipelineBlocker =>
  kind === undefined ? { cause } : { cause, action: { kind, label: ACTION_LABEL[kind] }, ...(chooseProvider ? { chooseProvider: true as const } : {}) };
const blocked = (cause: string, kind?: PipelineActionKind, chooseProvider = false): Result => ({ state: "blocked", blocker: block(cause, kind, chooseProvider) });
const failed = (cause: string, kind?: PipelineActionKind, chooseProvider = false): Result => ({ state: "failed", blocker: block(cause, kind, chooseProvider) });
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
  if (input.space.saved) return input.space.localOnly ? { state: "done", caption: input.device === "browser" ? "Audio stays in this browser" : `Audio stays on this ${input.device === "mac" ? "Mac" : input.device}` } : { state: "done" };
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
  if (pending?.retryAt && pending.retryAt > Date.now()) return { state: "waiting", caption: SPACE_COPY.retryIn(pending.retryAt - Date.now()) };
  const failure = pending?.failed;
  if (failure !== undefined) {
    switch (failure.kind) {
      case "auth": return blocked(SPACE_COPY.sessionExpired(device), "sign-in");
      case "quota": return blocked(SPACE_COPY.quota(device), "manage-storage");
      case "offline":
        return failed(SPACE_COPY.unreachable(device), "retry");
      case "timeout": return failed(SPACE_COPY.timeout(device), "retry");
      case "rejected": return failed("Couldn't sync to your TinyCloud space.", "retry");
      case "server": return failed(SPACE_COPY.server(failure.message, device), "retry");
      case "source": return failed(`Couldn't read the recording on ${deviceName(device)}.`);
      case "other": return failed(`Couldn't sync to your TinyCloud space.`, "retry");
    }
  }
  if (!online) return { state: "waiting", caption: SPACE_COPY.offlineCaption };
  const upload = pending?.upload;
  if (upload?.state === "preparing") return { state: "active", caption: "Preparing audio upload…" };
  if (upload?.state === "uploading") {
    return withProgress("active", SPACE_COPY.uploading(fraction(upload.bytes, upload.total)), fraction(upload.bytes, upload.total));
  }
  if (upload?.state === "retrying") return withProgress("active", SPACE_COPY.retrying, fraction(upload.bytes, upload.total));
  const ahead = pending?.waitingBehind;
  if (ahead !== undefined && ahead > 0) return { state: "waiting", caption: "Waiting to start" };
  if (input.space.lane.busy) return { state: "waiting", caption: "Waiting to start" };
  return { state: "waiting", caption: SPACE_COPY.waiting };
}

/** The model a Local note waits on: null once nothing about the model stands in the way. */
function modelStep(od: PipelineOnDevice, device: PipelineDevice): Result | null {
  const { model, download } = od;
  switch (od.appleSpeech) {
    case "unsupported": return blocked(LOCAL_COPY.speechUnsupported(device));
    case "locale_unsupported": return blocked(LOCAL_COPY.speechLocaleUnsupported);
    case "asset_missing": return download === "failed" ? failed(LOCAL_COPY.speechFailed, "retry") : { state: "active", caption: LOCAL_COPY.gettingSpeech };
    case "ready": return null;
    case undefined: break;
  }
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
  if (sync?.state === "failed") return failed(LOCAL_COPY.syncFailed(), "retry");
  if (sync?.state === "syncing") return { state: "active", caption: LOCAL_COPY.adding };
  if (sync?.state === "synced" || sync?.state === "unrecorded") return { state: "done" };
  if (stt === null) {
    const model = modelStep(od, input.device);
    if (model !== null) return model;
    return saved ? { state: "waiting", caption: LOCAL_COPY.notStarted } : { state: "upcoming" };
  }
  switch (stt.state) {
    case "done":
      if (!saved) return { state: "done", sublabel: LOCAL_COPY.readyOnDevice(input.device) };
      // Nothing is adding it (`sync` is null) and the space has no transcript: an attempt that never ran is a blocker, never "adding".
      return input.transcript.spaceReading === true ? { state: "waiting", caption: checking(input.transcript) } : blocked(LOCAL_COPY.notAdded(input.device), "retry");
    case "failed": return failed(LOCAL_COPY.failed(undefined, input.device), "retry", true);
    case "cancelled": return blocked(LOCAL_COPY.cancelled(input.device), "retry", true);
    case "running": {
      const progress = queue?.percent == null ? null : Math.min(1, Math.max(0, queue.percent / 100));
      return withProgress("active", input.device === "mac" ? LOCAL_COPY.transcribingOnMac(progress) : LOCAL_COPY.transcribing(progress), progress);
    }
    case "queued": return { state: "waiting", caption: LOCAL_COPY.queued(queue?.position ?? null) };
    case "waiting_for_model": return modelStep(od, input.device) ?? { state: "waiting", caption: LOCAL_COPY.queued(queue?.position ?? null) };
  }
}

function cloudBlockedStep(reason: PipelineBlockedReason, provider: NotePipelineInput["transcriptProvider"]): Result {
  const name = provider === "powerful" ? "Powerful" : provider === "unknown" ? "transcription" : "Private transcription";
  switch (reason) {
    case "checking": return { state: "waiting", caption: provider === "private" ? PRIVATE_COPY.checking : `Checking ${name}…` };
    case "unavailable": return blocked(provider === "private" ? PRIVATE_COPY.unavailable : `${name} isn't available right now`, "check-again");
    case "check-failed": return blocked(provider === "private" ? PRIVATE_COPY.checkFailed : `Couldn't check whether ${name} is available`, "check-again");
    case "no-consent": return blocked(provider === "private" ? PRIVATE_COPY.noConsent : `Waiting for your OK to use ${name}`, "review-consent");
  }
}

function cloudStep(cloud: PipelineCloud | null, spaceSaved: boolean, checkingCaption: string | null, provider: NotePipelineInput["transcriptProvider"] = "private"): Result {
  if (!spaceSaved) return { state: "upcoming" };
  if (cloud === null) return { state: "waiting", caption: checkingCaption ?? (provider === "powerful" ? "Waiting for Powerful" : provider === "unknown" ? "Waiting for transcription" : PRIVATE_COPY.notStarted) };
  switch (cloud.kind) {
    case "done": return { state: "done", sublabel: cloud.outcome === "no_speech" ? TRANSCRIPT_COPY.noSpeechInSpace : TRANSCRIPT_COPY.savedInSpace };
    case "held": return blocked(cloud.message.trim() || PRIVATE_COPY.notStarted);
    case "failed":
      return failed(PRIVATE_COPY.failed(cloud.code, provider), cloud.retryable ? "retry" : undefined, cloud.retryable);
    case "blocked": return cloudBlockedStep(cloud.reason, provider);
    case "active": {
      const status = cloud.status;
      switch (status.kind) {
        case "waiting": return { state: "waiting", caption: provider === "powerful" ? "Waiting for Powerful to start" : provider === "unknown" ? "Waiting for transcription to start" : PRIVATE_COPY.waiting(status.position) };
        case "preparing": return { state: "active", caption: PRIVATE_COPY.preparing };
        case "uploading": return status.progress === undefined
          ? { state: "active", caption: provider === "powerful" ? "Sending to Powerful (AssemblyAI)" : provider === "unknown" ? "Sending audio for transcription" : PRIVATE_COPY.sending }
          : withProgress("active", `${provider === "powerful" ? "Sending to Powerful (AssemblyAI)" : provider === "unknown" ? "Sending audio for transcription" : PRIVATE_COPY.sending} · ${percentText(status.progress)}`, status.progress);
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
  if (input.route === "private-cloud" && !input.space.saved) return { state: "waiting", caption: PRIVATE_COPY.afterUpload };
  if (inSpace !== null) return { state: "done", sublabel: inSpace === "no_speech" ? TRANSCRIPT_COPY.noSpeechInSpace : TRANSCRIPT_COPY.savedInSpace };
  if (input.route === "private-cloud" && cloud === null && input.transcript.cloudIdle === true) return { state: "skipped" };
  if (input.route === "private-cloud") return cloudStep(cloud, input.space.saved, input.transcript.spaceReading === true ? checking(input.transcript) : null, input.transcriptProvider);
  if (onDevice === null) return input.space.saved ? { state: "waiting", caption: input.transcript.spaceReading === true ? checking(input.transcript) : LOCAL_COPY.notStarted } : { state: "upcoming" };
  return onDeviceStep(input, onDevice);
}

function notesStep(input: NotePipelineInput, transcript: StepState): Result {
  const sync = input.notes;
  if (sync.state === "synced") return { state: "done" };
  if (sync.state === "unreadable") return failed(NOTES_COPY.unreadable(sync.cause, input.device), "retry");
  if (sync.state === "syncing") return { state: "active", caption: NOTES_COPY.syncing };
  if (sync.state === "failed") return failed(NOTES_COPY.failed, "retry");
  if (!input.space.saved) return { state: "upcoming" };
  switch (sync.state) {
    case "skipped": return sync.reason === "no-note" ? { state: "skipped" } : { state: "waiting", caption: NOTES_COPY.waitingForRow };
    // Nothing has started the sync. Behind a transcript that is still running or needs you, it is not its turn: that step owns the blocker.
    case "idle": return (transcript === "done" || transcript === "skipped") && input.transcript.spaceReading !== true ? blocked(NOTES_COPY.notSynced, "retry") : { state: "upcoming" };
  }
}

const UNREACHED: Result = { state: "upcoming" };
const needsYou = (state: StepState) => state === "blocked" || state === "failed";

export function notePipeline(input: NotePipelineInput): NotePipeline {
  const phone = phoneStep(input);
  // A quarantined or unwritten capture has no audio that the uploader can read yet; this is a capture fact, not a
  // dependency on the phone track's position in a sequence.
  const audioUnavailable = input.capture.issue === "recoveryFailed" || input.capture.issue === "quarantined" || input.capture.issue === "write_failed";
  const space: Result = audioUnavailable
    ? UNREACHED
    : input.capture.finalizing
      ? { state: "upcoming", caption: SPACE_COPY.afterRecording }
      : spaceStep(input);
  const { readError, inSpace } = input.transcript;
  // A failed read leaves the route unknown: with no transcript in the space that is a failure, with one the transcript is done (and the failure is shown below).
  const transcript: Result = readError != null && inSpace === null
    ? failed(LOCAL_COPY.readFailed(readError), "retry")
    : input.route === "off" && readError == null ? { state: "skipped" } : transcriptStep(input);
  const notes: Result = !input.hasNotesOrMoments && input.notes.state !== "unreadable"
    ? { state: "skipped" }
    : notesStep(input, transcript.state);

  const results: [StepKey, string, Result][] = [
    ["phone", STEP_LABEL.phone(input.device), phone],
    ["space", input.space.localOnly ? "Record in your TinyCloud space" : STEP_LABEL.space, space],
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
  // The transcript is in the space but the phone could not record that: the step is done, the failure is not dropped, and it has its own repair.
  const od = input.transcript.onDevice;
  const unrecorded = od?.sync?.state === "unrecorded" ? LOCAL_COPY.unrecorded(input.device) : null;
  if (unrecorded !== null) {
    if (blocker === undefined) {
      blocker = block(unrecorded, "retry");
      current = "transcript";
    } else notices.push(unrecorded);
  }
  if (unread && blocker === undefined) blocker = block(failedReads.join(" "), "reread");
  else if (unread) notices.push(...failedReads);

  const pipeline: NotePipeline = {
    steps, current, done: done && !unread && unrecorded === null,
    ...(input.transcript.persistedState === undefined ? {} : {
      transcriptionState: input.transcript.persistedState,
      ...(input.transcript.errorCode === undefined ? {} : { transcriptionErrorCode: input.transcript.errorCode }),
    }),
  };
  if (blocker !== undefined) pipeline.blocker = blocker;
  if (notices.length > 0) pipeline.notice = notices.join(" ");
  return pipeline;
}
