import { advanceAccountGeneration } from "./accountContext";
import { VoiceNotes } from "./nativeVoiceNotes";
import type { VoiceNotePipeline } from "./voiceNotePipeline";

const TRANSITION_KEY = "exo.capture.transitionGen";
const FAILURE = "Couldn't update this phone's recording settings. Try again.";
class AccountStateTimeout extends Error {}

export function nextTransitionGen(nativeGen: number): number {
  const local = Number(globalThis.localStorage?.getItem(TRANSITION_KEY) ?? 0) || 0;
  return Math.max(nativeGen, local) + 1;
}

function remember(gen: number): void {
  globalThis.localStorage?.setItem(TRANSITION_KEY, String(gen));
}

function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  return Promise.race([operation, new Promise<never>((_, reject) =>
    setTimeout(() => reject(new AccountStateTimeout("Native account update timed out")), ms))]);
}

/** A failed handoff never authorizes a credential clear. */
export async function handoffBeforeCredentialClear(did: string | null, pipeline: VoiceNotePipeline | null,
  timeoutMs = 10_000): Promise<{
  ok: boolean; failClosed: boolean; message: string | null;
}> {
  if (!did) return { ok: true, failClosed: false, message: null };
  let gen: number;
  try {
    gen = nextTransitionGen((await VoiceNotes.getCaptureDefaults()).transitionGen);
    await deadline(VoiceNotes.setAccountState({ status: "transitioning", accountDid: did, transitionGen: gen }), timeoutMs);
    remember(gen);
  } catch (caught) {
    if (caught instanceof AccountStateTimeout && gen! > 0) {
      try {
        await deadline(VoiceNotes.setAccountState({ status: "signed_in", accountDid: did, transitionGen: gen! + 1 }), timeoutMs);
        remember(gen! + 1);
      } catch {
        return { ok: false, failClosed: true, message: "Recordings are being kept unassigned until Exo can update this phone. Try again." };
      }
    }
    return { ok: false, failClosed: false, message: FAILURE };
  }
  advanceAccountGeneration();
  pipeline?.cancelAll();
  try { await pipeline?.quiescent(5_000); } catch { /* generation still bars new work */ }
  try {
    await deadline(VoiceNotes.setAccountState({ status: "signed_out", accountDid: null, transitionGen: gen + 1 }), timeoutMs);
    remember(gen + 1);
    return { ok: true, failClosed: false, message: null };
  } catch {
    try {
      await deadline(VoiceNotes.setAccountState({ status: "signed_in", accountDid: did, transitionGen: gen + 2 }), timeoutMs);
      remember(gen + 2);
      return { ok: false, failClosed: false, message: FAILURE };
    } catch {
      return { ok: false, failClosed: true,
        message: "Recordings are being kept unassigned until Exo can update this phone. Try again." };
    }
  }
}
