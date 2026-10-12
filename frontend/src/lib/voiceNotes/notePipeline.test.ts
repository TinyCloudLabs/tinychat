// The note pipeline selector: every row of the stages table (design §1), the order of steps, and the
// stuck-state contract (a blocked or failed step always says why).
import { describe, expect, test } from "bun:test";

import type { OnDeviceSttStatus } from "./onDeviceStt";
import type { NoteSttState } from "./nativeVoiceNotes";
import {
  notePipeline,
  pipelineActionPriority,
  type NotePipeline,
  type NotePipelineInput,
  type PipelineActionKind,
  type PipelineDownloadState,
  type PipelineModelState,
  type PipelineSttState,
  type StepKey,
  type StepState,
} from "./notePipeline";

// The mirrors accept what the stores publish today.
const _stt: PipelineSttState = "queued" as NoteSttState["state"];
const _model: PipelineModelState = "ready" as OnDeviceSttStatus["models"][number]["state"];
const _download: PipelineDownloadState = "idle" as OnDeviceSttStatus["download"]["state"];
void [_stt, _model, _download];

type Patch = {
  device?: NotePipelineInput["device"];
  route?: NotePipelineInput["route"];
  hasNotesOrMoments?: boolean;
  online?: boolean;
  capture?: Partial<NotePipelineInput["capture"]>;
  space?: Partial<NotePipelineInput["space"]>;
  transcript?: Partial<NotePipelineInput["transcript"]>;
  notes?: NotePipelineInput["notes"];
};

/** A recorded, finalized note that is waiting to upload, route off, nothing else going on. */
function input(patch: Patch = {}): NotePipelineInput {
  return {
    device: patch.device ?? "phone",
    route: patch.route ?? "off",
    hasNotesOrMoments: patch.hasNotesOrMoments ?? false,
    online: patch.online ?? true,
    capture: { finalizing: false, issue: null, ...patch.capture },
    space: { saved: false, pending: {}, lane: { busy: false, depth: 0 }, ...patch.space },
    transcript: { inSpace: null, onDevice: null, cloud: null, ...patch.transcript },
    notes: patch.notes ?? { state: "idle" },
  };
}

const SAVED = { saved: true, pending: null } as const;
const od = (patch: Partial<NonNullable<NotePipelineInput["transcript"]["onDevice"]>> = {}) => ({
  stt: null, queue: null, model: { state: "ready" as const, bytes: 640, totalBytes: 640, error: null }, download: "idle" as const, sync: null,
  ...patch,
});
const stt = (state: PipelineSttState, error: string | null = null) => ({ state, error });
const local = (patch: Patch["transcript"] & {}, extra: Patch = {}): Patch => ({ route: "on-device", transcript: patch, ...extra });
const cloud = (c: NonNullable<NotePipelineInput["transcript"]["cloud"]>, extra: Patch = {}): Patch => ({
  route: "private-cloud", space: SAVED, transcript: { cloud: c }, ...extra,
});

interface Row {
  name: string;
  patch: Patch;
  states?: Partial<Record<StepKey, StepState>>;
  current: StepKey | null;
  caption?: string;
  cause?: string | RegExp;
  action?: PipelineActionKind;
  notice?: string;
}

const ROWS: Row[] = [
  // 1. On this phone
  { name: "phone: finishing the recording", patch: { capture: { finalizing: true } }, states: { phone: "active", space: "upcoming" }, current: "phone", caption: "Finishing the recording…" },
  { name: "phone: finalize timed out, Exo finishes it next launch (no action)", patch: { capture: { issue: "finalization_timed_out" } }, states: { phone: "blocked", space: "waiting" }, current: "phone", cause: "Exo will finish it next launch" },
  { name: "phone: recovery failed, audio kept", patch: { capture: { issue: "recoveryFailed" } }, states: { phone: "failed" }, current: "phone", cause: "Couldn't recover · audio kept" },
  { name: "phone: quarantined", patch: { capture: { issue: "quarantined" } }, states: { phone: "failed" }, current: "phone", cause: "Couldn't recover · audio kept" },
  { name: "phone: write failed (info only)", patch: { capture: { issue: "write_failed" } }, states: { phone: "failed" }, current: "phone", cause: "Couldn't write the recording" },
  { name: "phone: partial audio is saved, with a notice", patch: { capture: { issue: "partial_audio" } }, states: { phone: "done", space: "waiting" }, current: "space", notice: "Saved · part of this recording couldn't be written" },
  { name: "phone: on a Mac the first step is named for it", patch: { device: "mac", capture: { finalizing: true } }, current: "phone", caption: "Finishing the recording…" },

  // 2. In your space
  { name: "space: waiting to upload", patch: {}, states: { phone: "done", space: "waiting" }, current: "space", caption: "Waiting to upload" },
  { name: "space: next in line when the lane is busy and nothing is ahead", patch: { space: { pending: { upload: { state: "waiting", bytes: 0, total: 100 }, waitingBehind: 0 }, lane: { busy: true, depth: 3 } } }, current: "space", caption: "Waiting to upload · next in line" },
  { name: "space: nothing ahead and an idle lane is just waiting", patch: { space: { pending: { waitingBehind: 0 }, lane: { busy: false, depth: 0 } } }, current: "space", caption: "Waiting to upload" },
  { name: "space: 2nd in line is one note ahead", patch: { space: { pending: { waitingBehind: 1 }, lane: { busy: true, depth: 2 } } }, current: "space", caption: "Waiting to upload · 2nd in line" },
  { name: "space: 12th in line is eleven notes ahead", patch: { space: { pending: { waitingBehind: 11 }, lane: { busy: true, depth: 12 } } }, current: "space", caption: "Waiting to upload · 12th in line" },
  { name: "space: a busy lane with no per-note position never invents one", patch: { space: { pending: {}, lane: { busy: true, depth: 5 } } }, current: "space", caption: "Waiting to upload" },
  { name: "space: uploading 42%", patch: { space: { pending: { upload: { state: "uploading", bytes: 42, total: 100 } } } }, states: { space: "active" }, current: "space", caption: "Uploading audio to your TinyCloud space · 42%" },
  { name: "space: retrying", patch: { space: { pending: { upload: { state: "retrying", bytes: 42, total: 100 } } } }, states: { space: "active" }, current: "space", caption: "Retrying…" },
  { name: "space: signed out", patch: { space: { pending: { held: "signed-out" } } }, states: { space: "blocked" }, current: "space", cause: "You're signed out. This note is safe on this phone.", action: "sign-in" },
  { name: "space: signed out on a Mac", patch: { device: "mac", space: { pending: { held: "signed-out" } } }, current: "space", cause: "You're signed out. This note is safe on this Mac.", action: "sign-in" },
  { name: "space: recorded on another account (info, no action)", patch: { space: { pending: { held: "other-account" } } }, states: { space: "blocked" }, current: "space", cause: "Recorded on another account" },
  { name: "space: legacy note, account unknown (no action)", patch: { space: { pending: { held: "legacy" } } }, states: { space: "blocked" }, current: "space", cause: /which account/ },
  { name: "space: unowned note, account unknown (no action)", patch: { space: { pending: { held: "unowned" } } }, states: { space: "blocked" }, current: "space", cause: /which account/ },
  { name: "space: offline waits for a connection (no button)", patch: { online: false, space: { pending: {} } }, states: { space: "waiting" }, current: "space", caption: "Offline · Resumes automatically" },
  { name: "space: an offline failure while offline keeps waiting", patch: { online: false, space: { pending: { failed: { kind: "offline", message: "fetch failed" } } } }, states: { space: "waiting" }, current: "space", caption: "Offline · Resumes automatically" },
  { name: "space: an offline failure while online is Try again", patch: { space: { pending: { failed: { kind: "offline", message: "fetch failed" } } } }, states: { space: "failed" }, current: "space", cause: "Couldn't reach your space. This note is safe on this phone.", action: "retry" },
  { name: "space: timeout is Try again", patch: { space: { pending: { failed: { kind: "timeout", message: "deadline" } } } }, states: { space: "failed" }, current: "space", cause: "Saving timed out. This note is safe on this phone.", action: "retry" },
  { name: "space: server error is calm Try again copy", patch: { space: { pending: { failed: { kind: "server", message: "503 from kv" } } } }, states: { space: "failed" }, current: "space", cause: "Your space couldn't take this note. It is safe on this phone. Try again.", action: "retry" },
  { name: "space: quota is full (no action)", patch: { space: { pending: { failed: { kind: "quota", message: "quota" } } } }, states: { space: "blocked" }, current: "space", cause: "Your space is full" },
  { name: "space: an expired session is Sign in", patch: { space: { pending: { failed: { kind: "auth", message: "401" } } } }, states: { space: "blocked" }, current: "space", cause: "Your session ended. This note is safe on this phone.", action: "sign-in" },
  { name: "space: a source failure has calm copy and no action", patch: { space: { pending: { failed: { kind: "source", message: "Audio file is too large to read" } } } }, states: { space: "failed" }, current: "space", cause: "Couldn't read the recording on this phone." },
  { name: "space: a source failure with no message has the same copy", patch: { space: { pending: { failed: { kind: "source", message: " " } } } }, states: { space: "failed" }, current: "space", cause: "Couldn't read the recording on this phone." },
  { name: "space: an unknown error has calm copy and stays retryable", patch: { space: { pending: { failed: { kind: "other", message: "Mount point is read only" } } } }, states: { space: "failed" }, current: "space", cause: "Couldn't save this note. It is safe on this phone. Try again.", action: "retry" },
  { name: "space: an unknown error with no message has the same copy", patch: { space: { pending: { failed: { kind: "other", message: "  " } } } }, states: { space: "failed" }, current: "space", cause: "Couldn't save this note. It is safe on this phone. Try again.", action: "retry" },

  // 3. Transcript, Local
  { name: "local: before the note is in the space, nothing has started", patch: local({}), states: { space: "waiting", transcript: "upcoming" }, current: "space" },
  { name: "local: model absent is Get the model", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), model: { state: "absent", bytes: 0, totalBytes: 640, error: null } }) }, { space: SAVED }), states: { transcript: "blocked" }, current: "transcript", cause: "Transcripts on this phone need the on-device model.", action: "get-model" },
  { name: "local: model downloading shows percent", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), model: { state: "downloading", bytes: 268, totalBytes: 640, error: null }, download: "running" }) }, { space: SAVED }), states: { transcript: "active" }, current: "transcript", caption: "Waiting for the on-device model · 42%" },
  { name: "local: model verifying", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), model: { state: "verifying", bytes: 640, totalBytes: 640, error: null }, download: "running" }) }, { space: SAVED }), states: { transcript: "active" }, current: "transcript", caption: "Checking the on-device model…" },
  { name: "local: model failed is Try again with its error", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), model: { state: "failed", bytes: 0, totalBytes: 640, error: "checksum mismatch" } }) }, { space: SAVED }), states: { transcript: "failed" }, current: "transcript", cause: "The on-device model couldn't download · checksum mismatch", action: "retry" },
  { name: "local: download failed is Try again", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), download: "failed", model: { state: "queued", bytes: 0, totalBytes: 640, error: null } }) }, { space: SAVED }), states: { transcript: "failed" }, current: "transcript", cause: "The on-device model couldn't download", action: "retry" },
  { name: "local: waiting for Wi-Fi", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), download: "waiting_for_network", model: { state: "queued", bytes: 0, totalBytes: 640, error: null } }) }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Waiting for Wi-Fi" },
  { name: "local: Low Data Mode", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), download: "low_data_mode", model: { state: "queued", bytes: 0, totalBytes: 640, error: null } }) }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Waiting for Wi-Fi · Low Data Mode is on" },
  { name: "local: no native job, model downloading shows percent", patch: local({ onDevice: od({ model: { state: "downloading", bytes: 268, totalBytes: 640, error: null }, download: "running" }) }, { space: SAVED }), states: { transcript: "active" }, current: "transcript", caption: "Waiting for the on-device model · 42%" },
  { name: "local: no native job, model verifying", patch: local({ onDevice: od({ model: { state: "verifying", bytes: 640, totalBytes: 640, error: null }, download: "running" }) }, { space: SAVED }), states: { transcript: "active" }, current: "transcript", caption: "Checking the on-device model…" },
  { name: "local: no native job, waiting for Wi-Fi", patch: local({ onDevice: od({ download: "waiting_for_network", model: { state: "queued", bytes: 0, totalBytes: 640, error: null } }) }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Waiting for Wi-Fi" },
  { name: "local: no native job, Low Data Mode", patch: local({ onDevice: od({ download: "low_data_mode", model: { state: "queued", bytes: 0, totalBytes: 640, error: null } }) }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Waiting for Wi-Fi · Low Data Mode is on" },
  { name: "local: no native job, model absent is Get the model", patch: local({ onDevice: od({ model: { state: "absent", bytes: 0, totalBytes: 640, error: null } }) }, { space: SAVED }), states: { transcript: "blocked" }, current: "transcript", cause: "Transcripts on this phone need the on-device model.", action: "get-model" },
  { name: "local: no native job, model download in the background before upload", patch: local({ onDevice: od({ model: { state: "downloading", bytes: 64, totalBytes: 640, error: null }, download: "running" }) }), states: { space: "waiting", transcript: "active" }, current: "transcript", caption: "Waiting for the on-device model · 10%" },
  { name: "local on iOS: speech not on the phone yet is a short Getting speech from iOS, not a model", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), appleSpeech: "asset_missing", model: null }) }, { space: SAVED }), states: { transcript: "active" }, current: "transcript", caption: "Getting speech from iOS…" },
  { name: "local on iOS: the speech install failed is Try again", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), appleSpeech: "asset_missing", download: "failed", model: null }) }, { space: SAVED }), states: { transcript: "failed" }, current: "transcript", cause: "Couldn't get speech from iOS", action: "retry" },
  { name: "local on iOS: an iPhone without on-device speech says so and offers nothing", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), appleSpeech: "unsupported", model: null }) }, { space: SAVED }), states: { transcript: "blocked" }, current: "transcript", cause: "On-device transcription isn't available on this phone" },
  { name: "local on iOS: a language it does not support says so and offers nothing", patch: local({ onDevice: od({ stt: stt("waiting_for_model"), appleSpeech: "locale_unsupported", model: null }) }, { space: SAVED }), states: { transcript: "blocked" }, current: "transcript", cause: "On-device transcription doesn't support this language yet" },
  { name: "local on iOS: ready speech has no model step to block on", patch: local({ onDevice: od({ stt: stt("queued"), appleSpeech: "ready", model: null, queue: { position: 1, inLine: 1, percent: null } }) }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Queued · next" },
  { name: "local: queued 2nd", patch: local({ onDevice: od({ stt: stt("queued"), queue: { position: 2, inLine: 3, percent: null } }) }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Queued · 2nd" },
  { name: "local: queued next", patch: local({ onDevice: od({ stt: stt("queued"), queue: { position: 1, inLine: 1, percent: null } }) }, { space: SAVED }), current: "transcript", caption: "Queued · next" },
  { name: "local: transcribing 63%", patch: local({ onDevice: od({ stt: stt("running"), queue: { position: 1, inLine: 1, percent: 63 } }) }, { space: SAVED }), states: { transcript: "active" }, current: "transcript", caption: "Transcribing · 63%" },
  { name: "local: transcribing with no percent yet", patch: local({ onDevice: od({ stt: stt("running"), queue: { position: 1, inLine: 1, percent: null } }) }, { space: SAVED }), current: "transcript", caption: "Transcribing…" },
  { name: "local: transcript done on the phone before upload is Ready on this phone", patch: local({ onDevice: od({ stt: stt("done") }) }, { space: { saved: false, pending: { upload: { state: "uploading", bytes: 10, total: 100 } } } }), states: { phone: "done", space: "active", transcript: "done" }, current: "space", caption: "Uploading audio to your TinyCloud space · 10%" },
  { name: "local: transcript done on the phone, note saved, nothing adding it and no space evidence is a blocker, never an endless Adding", patch: local({ onDevice: od({ stt: stt("done") }) }, { space: SAVED }), states: { transcript: "blocked" }, current: "transcript", cause: "The transcript is ready on this phone but hasn't been added to this note", action: "retry" },
  { name: "local: the space row not read yet is Checking your space, not a blocker", patch: local({ onDevice: od({ stt: stt("done") }), spaceReading: true }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Checking your space…" },
  { name: "local: no on-device read yet and the space row not read yet is Checking your space", patch: local({ spaceReading: true }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Checking your space…" },
  { name: "private: the space row not read yet is Checking your space", patch: { route: "private-cloud", space: SAVED, transcript: { spaceReading: true } }, states: { transcript: "waiting" }, current: "transcript", caption: "Checking your space…" },
  { name: "local: the space row queued behind uploads says so", patch: local({ onDevice: od({ stt: stt("done") }), spaceReading: true, afterUploads: true }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Checking your space · after uploads" },
  { name: "local: no on-device read yet and the space row queued behind uploads says so", patch: local({ spaceReading: true, afterUploads: true }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Checking your space · after uploads" },
  { name: "private: the space row queued behind uploads says so", patch: { route: "private-cloud", space: SAVED, transcript: { spaceReading: true, afterUploads: true } }, states: { transcript: "waiting" }, current: "transcript", caption: "Checking your space · after uploads" },
  { name: "uploads ahead mean nothing once the row has been read", patch: local({ onDevice: od({ stt: stt("done") }), afterUploads: true }, { space: SAVED }), states: { transcript: "blocked" }, current: "transcript", cause: "The transcript is ready on this phone but hasn't been added to this note", action: "retry" },
  { name: "local: transcript syncing to the space", patch: local({ onDevice: od({ stt: stt("done"), sync: { state: "syncing" } }) }, { space: SAVED }), states: { transcript: "active" }, current: "transcript", caption: "Adding to this note…" },
  { name: "local: transcript sync failed has calm copy", patch: local({ onDevice: od({ stt: stt("done"), sync: { state: "failed", message: "write lane timed out" } }) }, { space: SAVED }), states: { transcript: "failed" }, current: "transcript", cause: "Couldn't add the transcript to this note", action: "retry" },
  { name: "local: transcript synced", patch: local({ onDevice: od({ stt: stt("done"), sync: { state: "synced" } }) }, { space: SAVED }), states: { space: "done", transcript: "done" }, current: null },
  { name: "local: native transcription failed has calm copy", patch: local({ onDevice: od({ stt: stt("failed", "decoder crashed") }) }, { space: SAVED }), states: { transcript: "failed" }, current: "transcript", cause: "Couldn't transcribe on this phone", action: "retry" },
  { name: "local: native transcription failed with no error still names the failure", patch: local({ onDevice: od({ stt: stt("failed") }) }, { space: SAVED }), current: "transcript", cause: "Couldn't transcribe on this phone", action: "retry" },
  { name: "local: cancelled is Try again", patch: local({ onDevice: od({ stt: stt("cancelled") }) }, { space: SAVED }), states: { transcript: "blocked" }, current: "transcript", cause: "Transcribing on this phone was cancelled", action: "retry" },
  { name: "local: saved but native never queued it", patch: local({ onDevice: od() }, { space: SAVED }), states: { transcript: "waiting" }, current: "transcript", caption: "Waiting to transcribe" },
  { name: "local: no speech found is done", patch: local({ inSpace: "no_speech" }, { space: SAVED }), states: { transcript: "done" }, current: null },
  { name: "local on a Mac: transcription failure has calm copy", patch: local({ onDevice: od({ stt: stt("failed", "boom") }) }, { device: "mac", space: SAVED }), current: "transcript", cause: "Couldn't transcribe on this Mac", action: "retry" },

  // 3. Transcript, Private
  { name: "private: before the note is in the space it waits for upload", patch: { route: "private-cloud" }, states: { space: "waiting", transcript: "waiting" }, current: "space", caption: "Waiting to upload" },
  { name: "private: waiting, 2nd", patch: cloud({ kind: "active", status: { kind: "waiting", position: 2 } }), states: { transcript: "waiting" }, current: "transcript", caption: "Waiting · 2nd" },
  { name: "private: preparing", patch: cloud({ kind: "active", status: { kind: "preparing" } }), states: { transcript: "active" }, current: "transcript", caption: "Preparing…" },
  { name: "private: sending to private cloud", patch: cloud({ kind: "active", status: { kind: "uploading" } }), states: { transcript: "active" }, current: "transcript", caption: "Sending audio to Private transcription" },
  { name: "private: sending 42% names its destination", patch: cloud({ kind: "active", status: { kind: "uploading", progress: 0.42 } }), states: { transcript: "active" }, current: "transcript", caption: "Sending audio to Private transcription · 42%" },
  { name: "private: in the queue #3", patch: cloud({ kind: "active", status: { kind: "queued", position: 3 } }), states: { transcript: "waiting" }, current: "transcript", caption: "In the queue · #3" },
  { name: "private: in the queue, place unknown", patch: cloud({ kind: "active", status: { kind: "queued", position: null } }), current: "transcript", caption: "In the queue" },
  { name: "private: transcribing 4 of 9", patch: cloud({ kind: "active", status: { kind: "processing", completed: 4, total: 9 } }), states: { transcript: "active" }, current: "transcript", caption: "Transcribing · 4 of 9" },
  { name: "private: saving transcript", patch: cloud({ kind: "active", status: { kind: "saving" } }), states: { transcript: "active" }, current: "transcript", caption: "Saving transcript" },
  { name: "private: unavailable is Check again", patch: cloud({ kind: "blocked", reason: "unavailable" }), states: { transcript: "blocked" }, current: "transcript", cause: "Private transcription isn't available right now", action: "check-again" },
  { name: "private: check failed is Check again", patch: cloud({ kind: "blocked", reason: "check-failed" }), states: { transcript: "blocked" }, current: "transcript", cause: "Couldn't check whether private transcription is available", action: "check-again" },
  { name: "private: still checking just waits", patch: cloud({ kind: "blocked", reason: "checking" }), states: { transcript: "waiting" }, current: "transcript", caption: "Checking private transcription…" },
  { name: "private: no consent (no action)", patch: cloud({ kind: "blocked", reason: "no-consent" }), states: { transcript: "blocked" }, current: "transcript", cause: "Private transcription is turned off" },
  { name: "private: hidden for this account (no action)", patch: cloud({ kind: "blocked", reason: "hidden" }), states: { transcript: "blocked" }, current: "transcript", cause: "Private transcription isn't available for this account" },
  { name: "private: held note shows its message (no action)", patch: cloud({ kind: "held", message: "This note began outside Exo. Transcribe it when you want." }), states: { transcript: "blocked" }, current: "transcript", cause: "This note began outside Exo. Transcribe it when you want." },
  { name: "private: retryable failure keeps its mapped copy", patch: cloud({ kind: "failed", code: "server_error", message: "Transcription hit a snag.", retryable: true, reference: "ref-1" }), states: { transcript: "failed" }, current: "transcript", cause: "Transcription hit a snag.", action: "retry" },
  { name: "private: non-retryable failure keeps its mapped copy and reference without retry action", patch: cloud({ kind: "failed", code: "recording_too_long", message: "This recording is too long to transcribe.", retryable: false, reference: "ref-9" }), states: { transcript: "failed" }, current: "transcript", cause: "This recording is too long to transcribe. · Reference ref-9" },
  { name: "private: no speech found is done", patch: cloud({ kind: "done", outcome: "no_speech" }), states: { transcript: "done" }, current: null },
  { name: "private: saved but no job yet", patch: { route: "private-cloud", space: SAVED }, states: { transcript: "waiting" }, current: "transcript", caption: "Waiting for private transcription" },
  { name: "private: a transcript in the space is not done before the note is saved", patch: { route: "private-cloud", transcript: { inSpace: "transcribed" } }, states: { space: "waiting", transcript: "waiting" }, current: "space" },
  { name: "private: no speech in the space is not done before the note is saved", patch: { route: "private-cloud", transcript: { inSpace: "no_speech" } }, states: { space: "waiting", transcript: "waiting" }, current: "space" },
  { name: "local: a transcript found in the space still counts", patch: local({ inSpace: "transcribed" }, { space: SAVED }), states: { transcript: "done" }, current: null },
  { name: "local: transcript saved while audio is still uploading", patch: local({ inSpace: "transcribed" }, { space: { pending: { upload: { state: "uploading", bytes: 42, total: 100 } } } }), states: { phone: "done", space: "active", transcript: "done" }, current: "space", caption: "Uploading audio to your TinyCloud space · 42%" },
  { name: "private: transcript is in the space", patch: { route: "private-cloud", space: SAVED, transcript: { inSpace: "transcribed" } }, states: { space: "done", transcript: "done" }, current: null },

  // 4. Notes synced
  { name: "notes: upcoming until the note is in the space", patch: { hasNotesOrMoments: true }, states: { space: "waiting", notes: "upcoming" }, current: "space" },
  { name: "notes: syncing", patch: { hasNotesOrMoments: true, space: SAVED, notes: { state: "syncing" } }, states: { notes: "active" }, current: "notes", caption: "Syncing notes…" },
  { name: "notes: sync failed is Try again", patch: { hasNotesOrMoments: true, space: SAVED, notes: { state: "failed" } }, states: { notes: "failed" }, current: "notes", cause: "Couldn't sync your notes", action: "retry" },
  { name: "notes: no row yet waits", patch: { hasNotesOrMoments: true, space: SAVED, notes: { state: "skipped", reason: "no-row" } }, states: { notes: "waiting" }, current: "notes", caption: "Waiting for the note to reach your space" },
  { name: "notes: nothing on this device to sync skips the step", patch: { hasNotesOrMoments: true, space: SAVED, notes: { state: "skipped", reason: "no-note" } }, states: { notes: "skipped" }, current: null },
  { name: "notes: not synced and nothing running is a blocker with Try again", patch: { route: "off", hasNotesOrMoments: true, space: SAVED, notes: { state: "idle" } }, states: { notes: "blocked" }, current: "notes", cause: "Your notes haven't reached your space yet", action: "retry" },
  { name: "notes: not synced, behind a transcript still running, is not its turn", patch: { route: "private-cloud", hasNotesOrMoments: true, space: SAVED, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed: 1, total: 3 } } }, notes: { state: "idle" } }, states: { transcript: "active", notes: "upcoming" }, current: "transcript" },
  { name: "notes: the local text could not be read is Try again with its cause", patch: { hasNotesOrMoments: true, space: SAVED, notes: { state: "unreadable", cause: "disk went away" } }, states: { notes: "failed" }, current: "notes", cause: "Couldn't read this note's text on this phone · disk went away", action: "retry" },
  { name: "transcript: a failed read is Try again with its cause, never ready", patch: { route: "private-cloud", space: SAVED, transcript: { inSpace: null, onDevice: null, cloud: null, readError: "The phone's note list wouldn't open: busy" } }, states: { transcript: "failed" }, current: "transcript", cause: "Couldn't check this note's transcript · The phone's note list wouldn't open: busy", action: "retry" },
  { name: "capture: a parked recording is Couldn't recover, with no upload progress", patch: { capture: { finalizing: false, issue: "quarantined" }, space: { saved: false, pending: null, lane: { busy: false, depth: 0 } } }, states: { phone: "failed" }, current: "phone", cause: "Couldn't recover · audio kept" },
  { name: "notes: synced", patch: { hasNotesOrMoments: true, space: SAVED, notes: { state: "synced" } }, states: { notes: "done" }, current: null },

  // Everything done / skipped
  { name: "done: route off, no notes, in the space", patch: { space: SAVED }, states: { phone: "done", space: "done", transcript: "skipped", notes: "skipped" }, current: null },
  { name: "done: private transcript and notes", patch: { route: "private-cloud", hasNotesOrMoments: true, space: SAVED, transcript: { inSpace: "transcribed" }, notes: { state: "synced" } }, states: { phone: "done", space: "done", transcript: "done", notes: "done" }, current: null },
];

const caption = (pipeline: NotePipeline, key: StepKey | null) => pipeline.steps.find((step) => step.key === key)?.caption;

describe("notePipeline: every row of the stages table", () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const pipeline = notePipeline(input(row.patch));
      for (const [key, state] of Object.entries(row.states ?? {})) {
        expect(pipeline.steps.find((step) => step.key === key)?.state).toBe(state);
      }
      expect(pipeline.current).toBe(row.current);
      expect(pipeline.done).toBe(row.current === null);
      if (row.caption !== undefined) expect(caption(pipeline, pipeline.current)).toBe(row.caption);
      if (row.cause === undefined) expect(pipeline.blocker).toBeUndefined();
      else if (typeof row.cause === "string") expect(pipeline.blocker?.cause).toBe(row.cause);
      else expect(pipeline.blocker?.cause).toMatch(row.cause);
      if (row.cause !== undefined) expect(pipeline.blocker?.action?.kind).toBe(row.action);
      expect(pipeline.notice).toBe(row.notice);
    });
  }
});

describe("notePipeline: shape", () => {
  test("steps are always the four, in order, with the device in the first label", () => {
    expect(notePipeline(input()).steps.map((s) => [s.key, s.label])).toEqual([
      ["phone", "Audio on this phone"], ["space", "Audio in your space"], ["transcript", "Transcript"], ["notes", "Notes"],
    ]);
    expect(notePipeline(input({ device: "mac" })).steps[0]!.label).toBe("Audio on this Mac");
  });

  test("transcript is skipped when the route is off, and notes when there are none", () => {
    const steps = notePipeline(input({ space: SAVED })).steps;
    expect(steps.find((s) => s.key === "transcript")?.state).toBe("skipped");
    expect(steps.find((s) => s.key === "notes")?.state).toBe("skipped");
    const withBoth = notePipeline(input({ route: "on-device", hasNotesOrMoments: true, space: SAVED })).steps;
    expect(withBoth.find((s) => s.key === "transcript")?.state).not.toBe("skipped");
    expect(withBoth.find((s) => s.key === "notes")?.state).not.toBe("skipped");
  });

  test("Ready on this phone is a sublabel on the done transcript step, not a caption", () => {
    const pipeline = notePipeline(input(local({ onDevice: od({ stt: stt("done") }) })));
    expect(pipeline.steps.find((s) => s.key === "transcript")).toMatchObject({ state: "done", sublabel: "Ready on this phone" });
    const mac = notePipeline(input(local({ onDevice: od({ stt: stt("done") }) }, { device: "mac" })));
    expect(mac.steps.find((s) => s.key === "transcript")?.sublabel).toBe("Ready on this Mac");
  });

  test("a transcript already in the space names its location explicitly", () => {
    const localResult = notePipeline(input(local({ inSpace: "transcribed" }, { space: SAVED })));
    expect(localResult.steps.find((s) => s.key === "transcript")).toMatchObject({ state: "done", sublabel: "Saved in your space" });
    const privateResult = notePipeline(input({ ...cloud({ kind: "done", outcome: "no_speech" }), space: SAVED }));
    expect(privateResult.steps.find((s) => s.key === "transcript")).toMatchObject({ state: "done", sublabel: "No speech found in your space" });
  });

  test("progress is carried as 0..1 for uploads, model downloads, local and private transcription", () => {
    const progress = (patch: Patch) => notePipeline(input(patch)).steps.find((s) => s.state === "active")?.progress;
    expect(progress({ space: { pending: { upload: { state: "uploading", bytes: 25, total: 100 } } } })).toBe(0.25);
    expect(progress(local({ onDevice: od({ stt: stt("running"), queue: { position: 1, inLine: 1, percent: 63 } }) }, { space: SAVED }))).toBeCloseTo(0.63);
    expect(progress(cloud({ kind: "active", status: { kind: "processing", completed: 4, total: 8 } }))).toBe(0.5);
    expect(progress(local({ onDevice: od({ stt: stt("waiting_for_model"), model: { state: "downloading", bytes: 320, totalBytes: 640, error: null }, download: "running" }) }, { space: SAVED }))).toBe(0.5);
  });

  test("an upload with an unknown total has no progress and no percent", () => {
    const pipeline = notePipeline(input({ space: { pending: { upload: { state: "uploading", bytes: 0, total: 0 } } } }));
    const space = pipeline.steps.find((s) => s.key === "space")!;
    expect(space.caption).toBe("Uploading audio to your TinyCloud space…");
    expect(space.progress).toBeUndefined();
  });

  test("a stuck step that is not first still becomes current, and later steps wait", () => {
    const pipeline = notePipeline(input({ space: { pending: { held: "signed-out" } }, route: "private-cloud", hasNotesOrMoments: true }));
    expect(pipeline.steps.map((s) => s.state)).toEqual(["done", "blocked", "waiting", "upcoming"]);
  });

  test("an active step is current ahead of a waiting one (Local transcribes while the upload waits)", () => {
    const pipeline = notePipeline(input(local({ onDevice: od({ stt: stt("running"), queue: { position: 1, inLine: 1, percent: 10 } }) })));
    expect(pipeline.steps.map((s) => s.state)).toEqual(["done", "waiting", "active", "skipped"]);
    expect(pipeline.current).toBe("transcript");
  });

  test("a step that needs you is current ahead of a moving one", () => {
    const pipeline = notePipeline(input(local({ onDevice: od({ stt: stt("running"), queue: { position: 1, inLine: 1, percent: 10 } }) }, { space: { pending: { held: "signed-out" } } })));
    expect(pipeline.current).toBe("space");
    expect(pipeline.blocker?.action?.kind).toBe("sign-in");
  });

  test("with two stuck steps the higher-priority action is the blocker", () => {
    const pipeline = notePipeline(input(local({ onDevice: od({ stt: stt("failed", "boom") }) }, { space: { pending: { held: "signed-out" } } })));
    expect(pipeline.current).toBe("space");
    expect(pipeline.blocker?.action?.kind).toBe("sign-in");
    const second = notePipeline(input({ route: "on-device", space: SAVED, hasNotesOrMoments: true, notes: { state: "failed" }, transcript: { onDevice: od({ stt: stt("waiting_for_model"), model: { state: "absent", bytes: 0, totalBytes: 640, error: null } }) } }));
    expect(second.current).toBe("transcript");
    expect(second.blocker?.action?.kind).toBe("get-model");
  });
});

describe("pipelineActionPriority", () => {
  test("sign-in > get-model > retry > check-again > no action", () => {
    const order: (PipelineActionKind | undefined)[] = ["sign-in", "get-model", "retry", "check-again", undefined];
    const ranks = order.map(pipelineActionPriority);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(order.length);
  });
});

describe("stuck-state contract", () => {
  const all = ROWS.map((row) => [row.name, notePipeline(input(row.patch))] as const);

  test("every blocked or failed step has its own non-empty cause, and only those steps do", () => {
    for (const [name, pipeline] of all) {
      for (const step of pipeline.steps) {
        const stuck = step.state === "blocked" || step.state === "failed";
        if (stuck) expect(step.blocker?.cause.trim().length, `${name}: ${step.key}`).toBeGreaterThan(0);
        else expect(step.blocker, `${name}: ${step.key}`).toBeUndefined();
      }
      const anyStuck = pipeline.steps.some((s) => s.state === "blocked" || s.state === "failed");
      if (anyStuck) expect(pipeline.blocker?.cause.trim().length, name).toBeGreaterThan(0);
      else expect(pipeline.blocker, name).toBeUndefined();
    }
  });

  test("the visible blocker is exactly the current step's blocker", () => {
    for (const [name, pipeline] of all) {
      if (pipeline.blocker === undefined) continue;
      expect(pipeline.steps.find((s) => s.key === pipeline.current)?.blocker, name).toEqual(pipeline.blocker);
    }
  });

  test("simultaneous failures: every step keeps its cause and action; one is visible", () => {
    const pipeline = notePipeline(input({
      route: "on-device", hasNotesOrMoments: true,
      space: { saved: true, pending: null },
      transcript: { onDevice: od({ stt: stt("failed", "decoder crashed") }) },
      notes: { state: "failed" },
    }));
    const byKey = Object.fromEntries(pipeline.steps.map((s) => [s.key, s]));
    expect(byKey.transcript!.blocker).toEqual({ cause: "Couldn't transcribe on this phone", action: { kind: "retry", label: "Try again" }, chooseProvider: true });
    expect(byKey.notes!.blocker).toEqual({ cause: "Couldn't sync your notes", action: { kind: "retry", label: "Try again" } });
    expect(pipeline.current).toBe("transcript");
    expect(pipeline.blocker).toEqual(byKey.transcript!.blocker);
  });

  test("signed-out upload plus a failed Local transcription keep both causes and actions", () => {
    const pipeline = notePipeline(input(local({ onDevice: od({ stt: stt("failed", "boom") }) }, { space: { pending: { held: "signed-out" } } })));
    const byKey = Object.fromEntries(pipeline.steps.map((s) => [s.key, s]));
    expect(byKey.space!.blocker?.action?.kind).toBe("sign-in");
    expect(byKey.transcript!.blocker).toEqual({ cause: "Couldn't transcribe on this phone", action: { kind: "retry", label: "Try again" }, chooseProvider: true });
    expect(pipeline.blocker).toEqual(byKey.space!.blocker);
  });

  test("three stuck steps at once all keep their blocker", () => {
    const pipeline = notePipeline(input({
      route: "private-cloud", hasNotesOrMoments: true,
      space: { saved: true, pending: null },
      transcript: { cloud: { kind: "blocked", reason: "unavailable" } },
      notes: { state: "failed" },
    }));
    expect(pipeline.steps.filter((s) => s.blocker !== undefined).map((s) => [s.key, s.blocker!.action?.kind])).toEqual([["transcript", "check-again"], ["notes", "retry"]]);
    expect(pipeline.blocker?.action?.kind).toBe("retry");
    expect(pipeline.current).toBe("notes");
  });

  test("the current step of a stuck pipeline is the stuck one", () => {
    for (const [name, pipeline] of all) {
      if (!pipeline.blocker) continue;
      const state = pipeline.steps.find((s) => s.key === pipeline.current)?.state;
      expect(["blocked", "failed"], name).toContain(state);
    }
  });

  test("no generic copy and no em dashes anywhere in the output", () => {
    for (const [name, pipeline] of all) {
      const text = JSON.stringify(pipeline);
      expect(text, name).not.toMatch(/something went wrong/i);
      expect(text, name).not.toContain("—");
    }
  });

  test("an unknown error maps to calm copy", () => {
    const message = "Mount point /Volumes/odd is read only";
    const pipeline = notePipeline(input({ space: { pending: { failed: { kind: "other", message } } } }));
    expect(pipeline.blocker?.cause).toBe("Couldn't save this note. It is safe on this phone. Try again.");
    const transcript = notePipeline(input(local({ onDevice: od({ stt: stt("failed", message) }) }, { space: SAVED })));
    expect(transcript.blocker?.cause).toBe("Couldn't transcribe on this phone");
  });

  test("a done pipeline has no current step and no blocker", () => {
    const pipeline = notePipeline(input({ space: SAVED }));
    expect(pipeline).toMatchObject({ done: true, current: null });
    expect(pipeline.blocker).toBeUndefined();
  });

  test("every action has a label", () => {
    for (const [name, pipeline] of all) if (pipeline.blocker?.action) expect(pipeline.blocker.action.label.length, name).toBeGreaterThan(0);
  });
});

describe("a failed read that other evidence outranks", () => {
  test("a transcript in the space with a failed ledger read: the transcript is done, the failure is a blocker with its own action, and the note is not done", () => {
    const pipeline = notePipeline(input({ space: SAVED, transcript: { inSpace: "transcribed", readError: "The phone's note list wouldn't open: busy" } }));
    expect(pipeline.steps.find((step) => step.key === "transcript")?.state).toBe("done");
    expect(pipeline.blocker).toEqual({ cause: "Some details about this note couldn't be read · The phone's note list wouldn't open: busy", action: { kind: "reread", label: "Try again" } });
    expect(pipeline.done).toBe(false);
  });

  test("a failed read of the parked-recordings list is shown with its cause, with or without other blockers", () => {
    const alone = notePipeline(input({ space: SAVED, capture: { readError: "EIO" } }));
    expect(alone.blocker?.cause).toBe("Couldn't check for recordings that failed to save · EIO");
    expect(alone.blocker?.action?.kind).toBe("reread");
    expect(alone.done).toBe(false);
    const beside = notePipeline(input({ route: "private-cloud", space: SAVED, transcript: { cloud: { kind: "blocked", reason: "check-failed" } }, capture: { readError: "EIO" } }));
    expect(beside.blocker?.action?.kind).toBe("check-again");
    expect(beside.notice).toBe("Couldn't check for recordings that failed to save · EIO");
  });

  test("a read error with no detail still says that the read failed", () => {
    expect(notePipeline(input({ space: SAVED, capture: { readError: "" } })).blocker?.cause).toBe("Couldn't check for recordings that failed to save");
  });

  test("reread never outranks a step's own action", () => {
    expect(pipelineActionPriority("reread")).toBe(0);
  });
});

describe("a transcript in the space that the phone could not record (P6 r1)", () => {
  const unrecorded = { state: "unrecorded" as const, message: "disk full" };

  test("the transcript step is done, the failure is the blocker with Try again, and the note is not done", () => {
    const pipeline = notePipeline(input({ space: SAVED, notes: { state: "synced" }, ...local({ inSpace: "no_speech", onDevice: od({ stt: stt("done"), sync: unrecorded }) }) }));
    expect(pipeline.steps.find((step) => step.key === "transcript")?.state).toBe("done");
    expect(pipeline.blocker).toEqual({ cause: "The transcript is in your space, but this phone couldn't record it.", action: { kind: "retry", label: "Try again" } });
    expect(pipeline.current).toBe("transcript");
    expect(pipeline.done).toBe(false);
  });

  test("before the row catches up the transcript is still done, not Adding", () => {
    const pipeline = notePipeline(input({ space: SAVED, ...local({ onDevice: od({ stt: stt("done"), sync: unrecorded }) }) }));
    expect(pipeline.steps.find((step) => step.key === "transcript")?.state).toBe("done");
    expect(pipeline.blocker?.cause).toBe("The transcript is in your space, but this phone couldn't record it.");
  });

  test("beside another blocker it is a notice, never dropped", () => {
    const pipeline = notePipeline(input({ space: SAVED, hasNotesOrMoments: true, notes: { state: "failed" }, ...local({ inSpace: "transcribed", onDevice: od({ stt: stt("done"), sync: unrecorded }) }) }));
    expect(pipeline.current).toBe("notes");
    expect(pipeline.notice).toBe("The transcript is in your space, but this phone couldn't record it.");
    expect(pipeline.done).toBe(false);
  });
});

describe("which retries let the user choose the provider", () => {
  const transcriptBlocker = (patch: Parameters<typeof input>[0]) => notePipeline(input(patch)).steps.find((s) => s.key === "transcript")?.blocker;

  test("a failed or cancelled Local transcription, and a retryable private failure, do", () => {
    expect(transcriptBlocker(local({ onDevice: od({ stt: stt("failed", "boom") }) }, { space: SAVED }))?.chooseProvider).toBe(true);
    expect(transcriptBlocker(local({ onDevice: od({ stt: stt("cancelled") }) }, { space: SAVED }))?.chooseProvider).toBe(true);
    const retryable = cloud({ kind: "failed", code: "server_error", message: "Transcription hit a snag.", retryable: true, reference: "ref-1" });
    expect(transcriptBlocker(retryable)?.chooseProvider).toBe(true);
  });

  test("a private failure that cannot be retried has no action, so nothing to choose", () => {
    const final = cloud({ kind: "failed", code: "recording_too_long", message: "Too long.", retryable: false, reference: "ref-9" });
    expect(transcriptBlocker(final)?.action).toBeUndefined();
    expect(transcriptBlocker(final)?.chooseProvider).toBeUndefined();
  });
});
