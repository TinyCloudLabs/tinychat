import { readableError } from "@/lib/readableError";
// JS owns the user's default. Native owns a live session's journaled options.
import { captureEngineAvailable, captureEngineKind, onDeviceTranscriptionAvailable } from "./captureEngine";
import { withCaptureDeadline } from "./accountHandoff";
import { VoiceNotes, VOICE_NOTE_MAX_DURATION_MS, type CaptureOptions, type TranscriberId } from "./nativeVoiceNotes";
import { appPlatform } from "@/lib/platform";

import { DEFAULT_STOP_AFTER, STOP_AFTER_VALUES, type RecordingField, type SetFields, type StopAfter } from "./recordingSettings";
import {
  SPEAKERS_KEY, STOP_AFTER_KEY, TRANSCRIBER_KEY, UPLOAD_AUDIO_KEY, UPLOAD_ENGINE_KEY,
  localStorageOrNull as storage, markLocalEdit, notifyRecordingSettings, subscribeRecordingSettings,
} from "./recordingSettingsLocal";

let memoryPreference: CaptureOptions = { transcriber: "on-device", identifySpeakers: true };

export const subscribeTranscriberPreference = subscribeRecordingSettings;

export function readTranscriberPreference(): CaptureOptions {
  const store = storage();
  if (!store) return memoryPreference;
  try {
    const saved = store.getItem(TRANSCRIBER_KEY);
    const transcriber: TranscriberId = saved === "off" || saved === "on-device" || saved === "private-cloud" || saved === "assemblyai" ? saved : "on-device";
    return { transcriber, identifySpeakers: store.getItem(SPEAKERS_KEY) !== "0", uploadAudio: store.getItem(UPLOAD_AUDIO_KEY) === "1" };
  } catch { return memoryPreference; }
}

/** Signed-out Mac capture without Whisper records audio only. A signed-in saved choice stays selected. */
export function effectiveTranscriber(pref: TranscriberId, signedIn: boolean): TranscriberId {
  const transcriber = signedIn ? pref : "on-device";
  if (signedIn && transcriber === "on-device" && captureEngineKind() === "web") return "private-cloud";
  if (!signedIn && transcriber === "on-device" && captureEngineAvailable()
    && captureEngineKind() === "tauri" && !onDeviceTranscriptionAvailable()) return "off";
  return transcriber;
}

/** Disabled speaker modes keep the preference but send false to native capture. */
export function effectiveCaptureOptions(pref: CaptureOptions, signedIn: boolean): CaptureOptions {
  const transcriber = effectiveTranscriber(pref.transcriber, signedIn);
  return { transcriber, identifySpeakers: (transcriber === "private-cloud" || transcriber === "assemblyai") && pref.identifySpeakers,
    uploadAudio: pref.uploadAudio === true };
}

export function readUploadAudioPreference(): boolean {
  try { return storage()?.getItem(UPLOAD_AUDIO_KEY) === "1" || (!storage() && memoryPreference.uploadAudio === true); }
  catch { return memoryPreference.uploadAudio === true; }
}

export async function setUploadAudioPreference(enabled: boolean): Promise<void> {
  if (appPlatform() === "web") {
    storage()?.setItem(UPLOAD_AUDIO_KEY, enabled ? "1" : "0");
    memoryPreference = { ...memoryPreference, uploadAudio: enabled };
    notifyRecordingSettings();
    markLocalEdit(["uploadAudio"]);
    return;
  }
  await commitPreference({ uploadAudio: enabled });
}

let memoryStopAfter: StopAfter = DEFAULT_STOP_AFTER;

const isStopAfter = (value: string | null | undefined): value is StopAfter =>
  STOP_AFTER_VALUES.includes(value as StopAfter);

/** The stored choice; a missing or unknown value is the 1-hour default. */
export function readStopAfterPreference(): StopAfter {
  const store = storage();
  if (!store) return memoryStopAfter;
  try {
    const saved = store.getItem(STOP_AFTER_KEY);
    return isStopAfter(saved) ? saved : DEFAULT_STOP_AFTER;
  } catch { return memoryStopAfter; }
}

export function setStopAfterPreference(value: StopAfter): void {
  memoryStopAfter = value;
  try { storage()?.setItem(STOP_AFTER_KEY, value); } catch { /* This session only. */ }
  notifyRecordingSettings();
  markLocalEdit(["stopAfter"]);
}

/** The limit a choice asks for; "off" is the 3-hour limit every recorder enforces. */
export function stopAfterMs(value: StopAfter): number {
  return value === "off" ? VOICE_NOTE_MAX_DURATION_MS : Number(value) * 60_000;
}

/** What the engine will start the next recording with: the one truth the default mode is shown from. */
export async function readDefaultTranscriber(): Promise<TranscriberId> {
  return (await VoiceNotes.getCaptureDefaults()).transcriber;
}

type EngineDefaults = Awaited<ReturnType<typeof VoiceNotes.getCaptureDefaults>>;

// Default writes run one at a time: each reads the preference when it runs, so a refresh can never overwrite a
// choice that is still being written.
let writeLane: Promise<unknown> = Promise.resolve();
function inOrder<T>(write: () => Promise<T>): Promise<T> {
  const run = writeLane.then(write);
  writeLane = run.catch(() => {});
  return run;
}

/** Writes the effective default for the current account to the engine and returns what it replaced, or null when nothing changed. Never during a sign-in or sign-out transition. */
async function writeEffectiveDefaults(pref: CaptureOptions, attempting?: (before: EngineDefaults) => void): Promise<EngineDefaults | null> {
  const current = await withCaptureDeadline(VoiceNotes.getCaptureDefaults());
  const effective = effectiveCaptureOptions(pref, current.accountDid !== null);
  // A preference write must not re-assign the previous DID during sign-out.
  if (current.status === "transitioning" || (current.transcriber === effective.transcriber && current.identifySpeakers === effective.identifySpeakers
    && (current.uploadAudio ?? false) === effective.uploadAudio)) return null;
  attempting?.(current);
  await withCaptureDeadline(VoiceNotes.setCaptureDefaults({ ...current, ...effective, transitionGen: current.transitionGen }));
  return current;
}

const CLOUD_REACH: Record<TranscriberId, number> = { off: 0, "on-device": 1, "private-cloud": 2, assemblyai: 3 };
const leastCloud = (a: TranscriberId, b: TranscriberId): TranscriberId => (CLOUD_REACH[a] <= CLOUD_REACH[b] ? a : b);

// Set when a failed save could not put the engine's default back. Recording waits for `settleDefaults` until it has.
let unreconciled: unknown = null;

/**
 * After a failed save: put each stored key back on its own, then the engine's default, each attempted whatever the
 * others did. If the keys could not all be restored, the engine goes to the less cloud-reaching of its old default
 * and what is stored now, so it never reaches further than what the screen will show. If the engine cannot be
 * written at all, recording is held (`settleDefaults`) rather than left on a default the screen does not show.
 */
async function restoreAfterFailure(
  caught: unknown,
  store: Storage | undefined,
  prior: { transcriber: string | null; speakers: string | null; uploadAudio: string | null } | null,
  before: EngineDefaults | null,
): Promise<unknown> {
  const problems: string[] = [];
  if (store && prior) {
    for (const [key, value] of [[TRANSCRIBER_KEY, prior.transcriber], [SPEAKERS_KEY, prior.speakers],
      [UPLOAD_AUDIO_KEY, prior.uploadAudio]] as const) {
      try {
        if (value === null) store.removeItem(key); else store.setItem(key, value);
      } catch (failure) {
        console.error(`[VoiceNotes] Could not restore ${key} after a failed save`, failure);
        problems.push("the saved choice could not be put back");
      }
    }
  }
  if (before) {
    const shown = effectiveCaptureOptions(readTranscriberPreference(), before.accountDid !== null);
    const unchanged = shown.transcriber === before.transcriber && shown.identifySpeakers === before.identifySpeakers
      && shown.uploadAudio === (before.uploadAudio ?? false);
    const target = unchanged ? before : {
      ...before,
      transcriber: leastCloud(before.transcriber, shown.transcriber),
      identifySpeakers: before.identifySpeakers && shown.identifySpeakers,
      uploadAudio: before.uploadAudio ?? false,
    };
    try {
      await withCaptureDeadline(VoiceNotes.setCaptureDefaults(target));
    } catch (failure) {
      console.error("[VoiceNotes] Could not restore the default transcription mode after a failed save", failure);
      unreconciled = failure;
      problems.push("the engine's default could not be put back, so recording is held until it is");
    }
  }
  notifyRecordingSettings();
  if (!problems.length) return caught;
  return new Error(`${readableError(caught)} (${problems.join("; ")})`, { cause: caught });
}

/** Resolves once the engine's default is the stored one again, or throws why it is not. Waits behind every default write in flight. */
export function settleDefaults(): Promise<void> {
  return inOrder(async () => {
    if (unreconciled === null) return;
    try {
      await writeEffectiveDefaults(readTranscriberPreference());
    } catch (caught) {
      console.error("[VoiceNotes] The default transcription mode is still not put right; recording is held", caught);
      throw new Error(`${readableError(caught)} (the default transcription mode could not be put right, so recording is held)`, { cause: caught });
    }
    unreconciled = null;
  });
}

/**
 * Sets which account the engine's defaults belong to (sign-in, an aborted sign-out, claiming a note), in the same
 * lane as every other default write. The engine's defaults are read, and the transcriber and speakers are taken
 * from the stored preference, when this step runs, so it can neither restore an older mode over a choice nor be
 * overwritten by one still queued. `plan` returns the account and generation to write, or null to write nothing.
 */
export function writeAccountDefaults(
  plan: (native: EngineDefaults) => { accountDid: string | null; transitionGen: number } | null,
): Promise<{ accountDid: string | null; transitionGen: number } | null> {
  return inOrder(async () => {
    const native = await withCaptureDeadline(VoiceNotes.getCaptureDefaults());
    const account = plan(native);
    if (!account) return null;
    const effective = effectiveCaptureOptions(readTranscriberPreference(), account.accountDid !== null);
    await withCaptureDeadline(VoiceNotes.setCaptureDefaults({ ...native, ...effective, ...account }));
    unreconciled = null;
    return account;
  });
}

/**
 * One change to the preference, applied as one unit inside the write lane. Only the changed field is carried in; the
 * rest is read from the stored preference when the write runs, so a request queued earlier can never write back what
 * an earlier change replaced. The stored keys are read first, then the engine is written, then both keys. If any
 * step fails, `restoreAfterFailure` puts the keys and the engine back, each on its own, and the call throws.
 */
async function commitPreference(change: Partial<CaptureOptions>, edit = true): Promise<void> {
  await inOrder(async () => {
    const store = storage();
    const prior = store ? { transcriber: store.getItem(TRANSCRIBER_KEY), speakers: store.getItem(SPEAKERS_KEY),
      uploadAudio: store.getItem(UPLOAD_AUDIO_KEY) } : null;
    const pref = { ...readTranscriberPreference(), ...change };
    const chosenTranscriber = change.transcriber !== undefined;
    let before: EngineDefaults | null = null;
    try {
      await writeEffectiveDefaults(pref, (current) => { before = current; });
      if (store) {
        if (chosenTranscriber) store.setItem(TRANSCRIBER_KEY, pref.transcriber);
        store.setItem(SPEAKERS_KEY, pref.identifySpeakers ? "1" : "0");
        store.setItem(UPLOAD_AUDIO_KEY, pref.uploadAudio ? "1" : "0");
      }
    } catch (caught) {
      throw await restoreAfterFailure(caught, store, prior, before);
    }
    memoryPreference = pref;
    unreconciled = null;
  });
  notifyRecordingSettings();
  if (edit) markLocalEdit(Object.keys(change) as RecordingField[]);
}

/** The effective choice changed under an unchanged preference (the Mac's Whisper became ready): rewrite the engine's default and tell the listeners. */
export async function refreshEffectiveTranscriber(): Promise<void> {
  await inOrder(async () => {
    await writeEffectiveDefaults(readTranscriberPreference());
    unreconciled = null;
  });
  notifyRecordingSettings();
}

export async function setDefaultTranscriber(transcriber: TranscriberId): Promise<void> {
  await commitPreference({ transcriber });
}

export async function setDefaultIdentifySpeakers(identifySpeakers: boolean): Promise<void> {
  await commitPreference({ identifySpeakers });
}

/**
 * Puts fields adopted from the synced document into this device's cache and, for the engine-backed ones, the capture
 * engine's copy (the same lane an edit uses, so phone shortcuts record with them). Not an edit: it neither stamps the
 * device nor tells sync. Throws if the engine refuses; nothing is marked synced then, and the next cycle repeats it.
 */
export async function adoptSyncedFields(fields: SetFields): Promise<void> {
  const store = storage();
  if (!store) return;
  const current = readTranscriberPreference();
  const web = appPlatform() === "web";
  const change: Partial<CaptureOptions> = {};
  if (fields.transcriber !== undefined && fields.transcriber !== current.transcriber) change.transcriber = fields.transcriber;
  if (fields.identifySpeakers !== undefined && fields.identifySpeakers !== current.identifySpeakers) change.identifySpeakers = fields.identifySpeakers;
  // On the web the audio preference is a cache only; the engine's copy follows at the next account write.
  if (!web && fields.uploadAudio !== undefined && fields.uploadAudio !== current.uploadAudio) change.uploadAudio = fields.uploadAudio;
  if (Object.keys(change).length > 0) {
    if (captureEngineAvailable()) await commitPreference(change, false);
    else {
      if (change.transcriber !== undefined) store.setItem(TRANSCRIBER_KEY, change.transcriber);
      if (change.identifySpeakers !== undefined) store.setItem(SPEAKERS_KEY, change.identifySpeakers ? "1" : "0");
      if (change.uploadAudio !== undefined) store.setItem(UPLOAD_AUDIO_KEY, change.uploadAudio ? "1" : "0");
    }
  }
  if (web && fields.uploadAudio !== undefined) {
    store.setItem(UPLOAD_AUDIO_KEY, fields.uploadAudio ? "1" : "0");
    memoryPreference = { ...memoryPreference, uploadAudio: fields.uploadAudio };
  }
  if (fields.stopAfter !== undefined) store.setItem(STOP_AFTER_KEY, fields.stopAfter);
  if (fields.uploadEngine !== undefined) store.setItem(UPLOAD_ENGINE_KEY, fields.uploadEngine);
  notifyRecordingSettings();
}

/** Legacy view helper; the controller API surfaces errors and is the new owner of choices. */
export async function setRecordingTranscriber(transcriber: TranscriberId): Promise<void> {
  try {
    await VoiceNotes.setRecordingOptions({ transcriber });
  } catch (err) {
    console.warn("[VoiceNotes] Could not set this recording's transcriber", err);
  }
}
