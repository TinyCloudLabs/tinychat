// JS owns the user's default. Native owns a live session's journaled options.
import { captureEngineAvailable, onDeviceTranscriptionAvailable } from "./captureEngine";
import { VoiceNotes, type CaptureOptions, type TranscriberId } from "./nativeVoiceNotes";

const TRANSCRIBER_KEY = "exo.voiceNotes.transcriber";
const SPEAKERS_KEY = "exo.voiceNotes.identifySpeakers";
const listeners = new Set<() => void>();
let memoryPreference: CaptureOptions = { transcriber: "on-device", identifySpeakers: false };

export function subscribeTranscriberPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function storage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function readTranscriberPreference(): CaptureOptions {
  const store = storage();
  if (!store) return memoryPreference;
  try {
    const saved = store.getItem(TRANSCRIBER_KEY);
    const transcriber: TranscriberId = saved === "off" || saved === "on-device" || saved === "private-cloud" || saved === "assemblyai"
      ? saved : "on-device";
    return { transcriber, identifySpeakers: store.getItem(SPEAKERS_KEY) === "1" };
  } catch { return memoryPreference; }
}

/** An installed engine without an on-device route maps the choice to private cloud; the stored preference is untouched. */
export function effectiveTranscriber(pref: TranscriberId, signedIn: boolean): TranscriberId {
  const transcriber = signedIn ? pref : "on-device";
  if (transcriber === "on-device" && captureEngineAvailable() && !onDeviceTranscriptionAvailable())
    return signedIn ? "private-cloud" : "off";
  return transcriber;
}

/** Disabled speaker modes keep the preference but send false to native capture. */
export function effectiveCaptureOptions(pref: CaptureOptions, signedIn: boolean): CaptureOptions {
  const transcriber = effectiveTranscriber(pref.transcriber, signedIn);
  return { transcriber, identifySpeakers: transcriber === "on-device" || transcriber === "assemblyai" ? pref.identifySpeakers : false };
}

export async function readDefaultTranscriber(): Promise<TranscriberId> {
  return readTranscriberPreference().transcriber;
}

/** Uses native's current generation; a preference change is never an account transition. */
async function writePreference(pref: CaptureOptions): Promise<void> {
  const current = await VoiceNotes.getCaptureDefaults();
  const effective = effectiveCaptureOptions(pref, current.accountDid !== null);
  // A preference write must not re-assign the previous DID during sign-out.
  if (current.status !== "transitioning")
    await VoiceNotes.setCaptureDefaults({ ...current, ...effective, transitionGen: current.transitionGen });
  memoryPreference = pref;
  try {
    storage()?.setItem(TRANSCRIBER_KEY, pref.transcriber);
    storage()?.setItem(SPEAKERS_KEY, pref.identifySpeakers ? "1" : "0");
  } catch { /* Keep the choice for this session when storage is unavailable. */ }
  for (const listener of listeners) listener();
}

export async function setDefaultTranscriber(transcriber: TranscriberId): Promise<void> {
  await writePreference({ ...readTranscriberPreference(), transcriber });
}

export async function setDefaultIdentifySpeakers(identifySpeakers: boolean): Promise<void> {
  await writePreference({ ...readTranscriberPreference(), identifySpeakers });
}

/** Legacy view helper; the controller API surfaces errors and is the new owner of choices. */
export async function setRecordingTranscriber(transcriber: TranscriberId): Promise<void> {
  try {
    await VoiceNotes.setRecordingOptions({ transcriber });
  } catch (err) {
    console.warn("[VoiceNotes] Could not set this recording's transcriber", err);
  }
}
