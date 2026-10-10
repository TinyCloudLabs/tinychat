// JS owns the user's default. Native owns a live session's journaled options.
import { captureCapabilities, captureEngineAvailable, captureEngineKind, onDeviceTranscriptionAvailable } from "./captureEngine";
import { VoiceNotes, type CaptureOptions, type TranscriberId } from "./nativeVoiceNotes";

const TRANSCRIBER_KEY = "exo.voiceNotes.transcriber";
const SPEAKERS_KEY = "exo.voiceNotes.identifySpeakers";
const listeners = new Set<() => void>();
let memoryPreference: CaptureOptions = { transcriber: "on-device", identifySpeakers: false };
let memoryExplicit = false;

/** What the recorder knows about the phone right now. `localModelReady` is null until the model's state has been read. */
export interface EffectiveContext {
  localModelReady: boolean | null;
  privateOffered: boolean;
}
let contextSource: (() => EffectiveContext) | null = null;

/** The recorder controller registers what it can see (model state, private-cloud offer) so every default write agrees with the knob. */
export function setEffectiveContextSource(source: () => EffectiveContext): () => void {
  contextSource = source;
  return () => { if (contextSource === source) contextSource = null; };
}

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

/** True once the user has picked a mode themselves; the untouched default is not a choice. */
export function transcriberChoiceIsExplicit(): boolean {
  const store = storage();
  if (!store) return memoryExplicit;
  try { return store.getItem(TRANSCRIBER_KEY) !== null; } catch { return memoryExplicit; }
}

/**
 * A signed-in phone that never chose a mode, with on-device transcription supported but its model known to be
 * absent, would wait forever on Local: its default is Private when that is offered, else Audio only. A mode the
 * user chose is never replaced; the recorder shows what it needs instead.
 */
function modelAbsentDefault(pref: TranscriberId, signedIn: boolean, context: EffectiveContext | null): "private-cloud" | "off" | null {
  if (!signedIn || pref !== "on-device" || !context || context.localModelReady !== false) return null;
  if (!captureCapabilities().localTranscription || !onDeviceTranscriptionAvailable() || transcriberChoiceIsExplicit()) return null;
  return context.privateOffered ? "private-cloud" : "off";
}

/** The default stands in for Local because the on-device model is missing. */
export function localModelSubstituted(pref: TranscriberId, signedIn: boolean): boolean {
  return modelAbsentDefault(pref, signedIn, contextSource?.() ?? null) !== null;
}

/** An installed engine without an on-device route maps the choice to private cloud; the stored preference is untouched. */
export function effectiveTranscriber(pref: TranscriberId, signedIn: boolean): TranscriberId {
  const substitute = modelAbsentDefault(pref, signedIn, contextSource?.() ?? null);
  if (substitute) return substitute;
  const transcriber = signedIn ? pref : "on-device";
  if (transcriber === "on-device" && captureEngineAvailable() && !onDeviceTranscriptionAvailable())
    return !signedIn && captureEngineKind() === "tauri" ? "off" : "private-cloud";
  return transcriber;
}

/** Disabled speaker modes keep the preference but send false to native capture. */
export function effectiveCaptureOptions(pref: CaptureOptions, signedIn: boolean): CaptureOptions {
  const transcriber = effectiveTranscriber(pref.transcriber, signedIn);
  return { transcriber, identifySpeakers: transcriber === "assemblyai"
    || transcriber === "on-device" && captureCapabilities().localTranscription ? pref.identifySpeakers : false };
}

export async function readDefaultTranscriber(): Promise<TranscriberId> {
  return readTranscriberPreference().transcriber;
}

/** Writes the effective default for the current account to the engine. Never during a sign-in or sign-out transition. */
async function writeEffectiveDefaults(pref: CaptureOptions): Promise<void> {
  const current = await VoiceNotes.getCaptureDefaults();
  const effective = effectiveCaptureOptions(pref, current.accountDid !== null);
  // A preference write must not re-assign the previous DID during sign-out.
  if (current.status !== "transitioning" && (current.transcriber !== effective.transcriber || current.identifySpeakers !== effective.identifySpeakers))
    await VoiceNotes.setCaptureDefaults({ ...current, ...effective, transitionGen: current.transitionGen });
}

/** Uses native's current generation; a preference change is never an account transition. */
async function writePreference(pref: CaptureOptions, chosenTranscriber: boolean): Promise<void> {
  await writeEffectiveDefaults(pref);
  memoryPreference = pref;
  if (chosenTranscriber) memoryExplicit = true;
  try {
    if (chosenTranscriber) storage()?.setItem(TRANSCRIBER_KEY, pref.transcriber);
    storage()?.setItem(SPEAKERS_KEY, pref.identifySpeakers ? "1" : "0");
  } catch { /* Keep the choice for this session when storage is unavailable. */ }
  for (const listener of listeners) listener();
}

/** The effective choice changed under an unchanged preference (the Mac's Whisper became ready or went away): rewrite the engine's default and tell the listeners. */
export async function refreshEffectiveTranscriber(): Promise<void> {
  await writeEffectiveDefaults(readTranscriberPreference());
  for (const listener of listeners) listener();
}

export async function setDefaultTranscriber(transcriber: TranscriberId): Promise<void> {
  await writePreference({ ...readTranscriberPreference(), transcriber }, true);
}

export async function setDefaultIdentifySpeakers(identifySpeakers: boolean): Promise<void> {
  await writePreference({ ...readTranscriberPreference(), identifySpeakers }, false);
}

/** Legacy view helper; the controller API surfaces errors and is the new owner of choices. */
export async function setRecordingTranscriber(transcriber: TranscriberId): Promise<void> {
  try {
    await VoiceNotes.setRecordingOptions({ transcriber });
  } catch (err) {
    console.warn("[VoiceNotes] Could not set this recording's transcriber", err);
  }
}
