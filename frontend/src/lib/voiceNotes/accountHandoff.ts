import { advanceAccountGeneration } from "./accountContext";
import { VoiceNotes } from "./nativeVoiceNotes";
import type { VoiceNotePipeline } from "./voiceNotePipeline";

const TRANSITION_KEY = "exo.capture.transitionGen";
const FAILURE = "Couldn't update this phone's recording settings. Try again.";
export class AccountStateTimeout extends Error {}

export function nextTransitionGen(nativeGen: number): number {
  const local = Number(globalThis.localStorage?.getItem(TRANSITION_KEY) ?? 0) || 0;
  return Math.max(nativeGen, local) + 1;
}

function remember(gen: number): void {
  globalThis.localStorage?.setItem(TRANSITION_KEY, String(gen));
}

export function withCaptureDeadline<T>(operation: Promise<T>, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AccountStateTimeout("Account operation timed out")), ms);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** A failed handoff never authorizes a credential clear. */
export async function handoffBeforeCredentialClear(did: string | null, pipeline: VoiceNotePipeline | null,
  timeoutMs = 10_000): Promise<{
  ok: boolean; failClosed: boolean; message: string | null;
}> {
  if (!did) return { ok: true, failClosed: false, message: null };
  let gen: number;
  try {
    gen = nextTransitionGen((await withCaptureDeadline(VoiceNotes.getCaptureDefaults(), timeoutMs)).transitionGen);
    await withCaptureDeadline(VoiceNotes.setAccountState({ status: "transitioning", accountDid: did, transitionGen: gen }), timeoutMs);
    remember(gen);
  } catch (caught) {
    if (caught instanceof AccountStateTimeout && gen! > 0) {
      try {
        await withCaptureDeadline(VoiceNotes.setAccountState({ status: "signed_in", accountDid: did, transitionGen: gen! + 1 }), timeoutMs);
        remember(gen! + 1);
      } catch {
        return { ok: false, failClosed: true, message: "Recordings are being kept unassigned until Exo can update this phone. Try again." };
      }
    }
    return { ok: false, failClosed: false, message: FAILURE };
  }
  advanceAccountGeneration();
  pipeline?.cancelAll();
  try { if (pipeline) await withCaptureDeadline(pipeline.quiescent(5_000), Math.min(5_000, timeoutMs)); }
  catch { /* generation still bars new work */ }
  try {
    await withCaptureDeadline(VoiceNotes.setAccountState({ status: "signed_out", accountDid: null, transitionGen: gen + 1 }), timeoutMs);
    remember(gen + 1);
    return { ok: true, failClosed: false, message: null };
  } catch {
    try {
      await withCaptureDeadline(VoiceNotes.setAccountState({ status: "signed_in", accountDid: did, transitionGen: gen + 2 }), timeoutMs);
      remember(gen + 2);
      return { ok: false, failClosed: false, message: FAILURE };
    } catch {
      return { ok: false, failClosed: true,
        message: "Recordings are being kept unassigned until Exo can update this phone. Try again." };
    }
  }
}
