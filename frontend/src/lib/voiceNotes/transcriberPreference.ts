import { readableError } from "@/lib/readableError";
// JS owns the user's default. Native owns a live session's journaled options.
import { captureEngineAvailable, captureEngineKind, onDeviceTranscriptionAvailable } from "./captureEngine";
import { withCaptureDeadline } from "./accountHandoff";
import { VoiceNotes, VOICE_NOTE_MAX_DURATION_MS, type CaptureOptions, type TranscriberId } from "./nativeVoiceNotes";
import { appPlatform } from "@/lib/platform";

import { DEFAULT_STOP_AFTER, STOP_AFTER_VALUES, type RecordingField, type SetFields, type StopAfter } from "./recordingSettings";
import {
  currentScope, localStorageOrNull as storage, notifyRecordingSettings, readStamp, readStored, snapshotStored,
  subscribeRecordingSettings, writeStored, type Scope, type Snapshot, type Stored,
} from "./recordingSettingsLocal";

// The preference lives in the cache of ONE scope (the signed-in account, or this device). Live reads use the scope this
// tab is signed in as. Every write names the scope it was started for and goes only there.
let memoryPreference: CaptureOptions = { transcriber: "on-device", identifySpeakers: true };

export const subscribeTranscriberPreference = subscribeRecordingSettings;

function preferenceOf(stored: Stored): CaptureOptions {
  const saved = stored.transcriber;
  const transcriber: TranscriberId = saved === "off" || saved === "on-device" || saved === "private-cloud" || saved === "assemblyai" ? saved : "on-device";
  return { transcriber, identifySpeakers: stored.identifySpeakers !== false, uploadAudio: stored.uploadAudio === true };
}

export function readTranscriberPreference(): CaptureOptions {
  if (!storage()) return memoryPreference;
  return preferenceOf(readStored(currentScope()));
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
  if (!storage()) return memoryPreference.uploadAudio === true;
  return readStored(currentScope()).uploadAudio === true;
}

export async function setUploadAudioPreference(enabled: boolean): Promise<void> {
  if (appPlatform() === "web") {
    const scope = currentScope();
    writeStored(scope, { uploadAudio: enabled }, { fields: ["uploadAudio"] });
    memoryPreference = { ...memoryPreference, uploadAudio: enabled };
    notifyRecordingSettings();
    return;
  }
  await commitPreference({ uploadAudio: enabled }, currentScope(), true);
}

let memoryStopAfter: StopAfter = DEFAULT_STOP_AFTER;

const isStopAfter = (value: string | null | undefined): value is StopAfter =>
  STOP_AFTER_VALUES.includes(value as StopAfter);

/** The stored choice; a missing or unknown value is the 1-hour default. */
export function readStopAfterPreference(): StopAfter {
  if (!storage()) return memoryStopAfter;
  const saved = readStored(currentScope()).stopAfter;
  return isStopAfter(saved) ? saved : DEFAULT_STOP_AFTER;
}

export function setStopAfterPreference(value: StopAfter): void {
  memoryStopAfter = value;
  try { writeStored(currentScope(), { stopAfter: value }, { fields: ["stopAfter"] }); } catch { /* This session only. */ }
  notifyRecordingSettings();
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
 * After a failed save: put the stored choice back, then the engine's default, each attempted whatever the other did.
 * If the choice could not be restored, the engine goes to the less cloud-reaching of its old default and what is stored
 * now, so it never reaches further than what the screen will show. If the engine cannot be written at all, recording is
 * held (`settleDefaults`) rather than left on a default the screen does not show.
 */
async function restoreAfterFailure(
  caught: unknown,
  snapshot: Snapshot | null,
  before: EngineDefaults | null,
): Promise<unknown> {
  const problems: string[] = snapshot ? snapshot.restore() : [];
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
 * One change to one scope's preference, applied as one unit inside the write lane. `scope` is the account (or the
 * device) the change was started for: the change is read from and written to that scope's cache only. Only the changed
 * field is carried in; the rest is read from the stored preference when the write runs, so a request queued earlier can
 * never write back what an earlier change replaced. The engine's copy follows only while that scope is the signed-in
 * one. If any step fails, `restoreAfterFailure` puts the stored choice and the engine back, and the call throws.
 */
async function commitPreference(change: Partial<CaptureOptions>, scope: Scope, edit: boolean): Promise<void> {
  await inOrder(async () => {
    // An adopted value never lands over an edit still waiting to be synced, whichever got into the lane first.
    const dirty = edit ? [] : readStamp(scope).dirty;
    const applied = Object.fromEntries(Object.entries(change).filter(([key]) => !dirty.includes(key as RecordingField))) as Partial<CaptureOptions>;
    if (Object.keys(applied).length === 0) return;
    const snapshot = snapshotStored(scope);
    const pref = { ...preferenceOf(readStored(scope)), ...applied };
    let before: EngineDefaults | null = null;
    try {
      // The engine holds one copy for the whole device: it follows the scope this tab is signed in as, and no other.
      if (scope === currentScope()) await writeEffectiveDefaults(pref, (current) => { before = current; });
      // Only what changed is written into an account's cache: a key nobody set stays unset, so it never travels as a
      // choice. The device's own keys keep writing all three, as they always have.
      const all = edit && scope === null;
      writeStored(scope, {
        ...(applied.transcriber !== undefined ? { transcriber: pref.transcriber } : {}),
        ...(all || applied.identifySpeakers !== undefined ? { identifySpeakers: pref.identifySpeakers } : {}),
        ...(all || applied.uploadAudio !== undefined ? { uploadAudio: pref.uploadAudio } : {}),
      }, edit ? { fields: Object.keys(applied) as RecordingField[] } : undefined);
    } catch (caught) {
      throw await restoreAfterFailure(caught, snapshot, before);
    }
    if (scope === currentScope()) memoryPreference = pref;
    unreconciled = null;
    // The engine write above is an await: if the signed-in account changed during it, the engine briefly holds this
    // scope's values. Rewriting it from whoever is signed in now (queued behind this step) puts it right.
    if (scope !== currentScope() && captureEngineAvailable()) void refreshEffectiveTranscriber().catch(() => {});
  });
  notifyRecordingSettings();
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
  await commitPreference({ transcriber }, currentScope(), true);
}

export async function setDefaultIdentifySpeakers(identifySpeakers: boolean): Promise<void> {
  await commitPreference({ identifySpeakers }, currentScope(), true);
}

/**
 * Puts fields adopted from `account`'s synced document into that account's cache, and, while that account is the
 * signed-in one, into the capture engine's copy (the same lane an edit uses, so phone shortcuts record with them). Not
 * an edit: it neither stamps the cache nor tells sync. Fields with an edit still waiting to be synced are skipped.
 * Throws if the engine refuses, after the fields that do not need it were applied; nothing is marked synced then, and
 * the next cycle repeats it.
 */
export async function adoptSyncedFields(account: string, fields: SetFields): Promise<void> {
  if (!storage()) return;
  const dirty = readStamp(account).dirty;
  const open = (field: RecordingField) => fields[field] !== undefined && !dirty.includes(field);
  const current = preferenceOf(readStored(account));
  const web = appPlatform() === "web";
  // The fields that need no engine are applied first, in one write.
  writeStored(account, {
    ...(open("stopAfter") ? { stopAfter: fields.stopAfter } : {}),
    ...(open("uploadEngine") ? { uploadEngine: fields.uploadEngine } : {}),
    // On the web the audio preference is a cache only; the engine's copy follows at the next account write.
    ...(web && open("uploadAudio") ? { uploadAudio: fields.uploadAudio } : {}),
  });
  if (web && open("uploadAudio") && account === currentScope()) memoryPreference = { ...memoryPreference, uploadAudio: fields.uploadAudio };
  notifyRecordingSettings();
  const change: Partial<CaptureOptions> = {};
  if (open("transcriber") && fields.transcriber !== current.transcriber) change.transcriber = fields.transcriber;
  if (open("identifySpeakers") && fields.identifySpeakers !== current.identifySpeakers) change.identifySpeakers = fields.identifySpeakers;
  if (!web && open("uploadAudio") && fields.uploadAudio !== current.uploadAudio) change.uploadAudio = fields.uploadAudio;
  if (Object.keys(change).length === 0) return;
  if (captureEngineAvailable()) {
    await commitPreference(change, account, false);
    return;
  }
  writeStored(account, {
    ...(change.transcriber !== undefined ? { transcriber: change.transcriber } : {}),
    ...(change.identifySpeakers !== undefined ? { identifySpeakers: change.identifySpeakers } : {}),
    ...(change.uploadAudio !== undefined ? { uploadAudio: change.uploadAudio } : {}),
  });
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
