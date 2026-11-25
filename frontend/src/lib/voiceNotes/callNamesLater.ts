// The save steps of names in the call and who spoke when (callNames.ts), loaded when a step first has work: only the
// desktop app reads names from a call, so the entry chunk the web app boots from does not carry them (TC-2882). Each
// step still never throws and is not awaited by the save: a chunk that does not load is a failed try, and the next
// commit or pass over the saved notes tries again, as after any other failed step.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { callSpeakerLabels } from "@/capture/library/callParticipants";
import type { CallNamesSaveOutcome } from "./callNames";
import { getDesktopCaptureExtras } from "./desktopCaptureExtras";

type CallNames = typeof import("./callNames");

/** Runs `step` once callNames.ts has loaded; `failed` (never a rejection) when it does not load. */
export function withCallNames<T>(step: (callNames: CallNames) => Promise<T>, failed: T,
  load: () => Promise<CallNames> = () => import("./callNames")): Promise<T> {
  return load().then(step).catch((error: unknown) => {
    console.warn("[callNames] The names from the call will be saved on the next try:",
      error instanceof Error ? error.message : String(error));
    return failed;
  });
}

/** `saveCallNames`, loaded on first use. "none" without loading it where there is no desktop app to read names from. */
export function saveCallNamesLater(tcw: TinyCloudWeb, sourceId: string, rowId: string,
  checkpoint?: () => void): Promise<CallNamesSaveOutcome> {
  if (!getDesktopCaptureExtras()?.callNames) return Promise.resolve("none");
  return withCallNames((callNames) => callNames.saveCallNames(tcw, sourceId, rowId, checkpoint), "failed");
}

/**
 * After a transcript commit: `saveCallSpeakerNames` with the "Them N" labels of `sentences` (`callSpeakerLabels`), loaded
 * on first use. "none" without loading it when no line carries a person of the call (`speaker_id` "call:…"), as then no
 * label does.
 */
export function saveTranscriptCallSpeakerNamesLater(tcw: TinyCloudWeb, sourceId: string, rowId: string,
  sentences: Parameters<typeof callSpeakerLabels>[0], checkpoint?: () => void): Promise<"none" | "saved" | "kept" | "failed"> {
  if (!sentences.some((sentence) => sentence.speaker_id?.startsWith("call:"))) return Promise.resolve("none");
  return withCallNames(async (callNames) => {
    const participants = await import("@/capture/library/callParticipants");
    return callNames.saveCallSpeakerNames(tcw, sourceId, rowId, participants.callSpeakerLabels(sentences), checkpoint);
  }, "failed");
}

/** `saveLocalCallSpeakerNames`, loaded on first use. */
export function saveLocalCallSpeakerNamesLater(tcw: TinyCloudWeb, sourceId: string, rowId: string,
  checkpoint?: () => void): Promise<"none" | "saved" | "kept" | "failed"> {
  return withCallNames((callNames) => callNames.saveLocalCallSpeakerNames(tcw, sourceId, rowId, checkpoint), "failed");
}
