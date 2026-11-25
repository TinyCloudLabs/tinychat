// Who spoke when, on this Mac. After a call recording is transcribed locally, the Whisper job names its remote lines
// from two things this Mac holds: the speaking timeline the app recorded from the meeting window, and the call's
// people by id. Neither needs the space, and neither may hold up the transcript: a read that fails or does not answer
// in time leaves "Them".
//
// The people: the app's names file holds them until the note's row does (`saveCallNames` clears it then), which is
// usually before a transcription of a long call ends. So when the names move to the row, the ids alone (no names) are
// kept here for 30 days, as long as the app keeps the timeline, and a new transcript of the same recording numbers
// the people the same way.
import { callRoster, parseCallParticipants, type CallParticipants, type CallRoster } from "@/capture/library/callParticipants";
import { logPipeline, logPipelineError } from "@/lib/debugLog";
import { getDesktopCaptureExtras } from "./desktopCaptureExtras";
import { assignCallSpeakers, mayNameCallSpeakers } from "./desktop/callSpeakers";
import type { LocalTranscript, VoiceNoteRecording } from "./nativeVoiceNotes";

/** localStorage key: recording id -> the call's people by id (`CallRoster`) and when they were kept. */
export const CALL_ROSTERS_KEY = "exo.callSpeakers.rosters";
const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_KEPT = 500;
/** How long the job waits for the timeline and the people before it stores the transcript with "Them". */
export const CALL_SPEAKERS_WAIT_MS = 2_000;

const PERSON_ID = /^[A-Za-z0-9_-]{1,32}$/;
type Kept = { self: string[]; others: string[]; at: number };

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const ids = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= 50 && value.every((id) => typeof id === "string" && PERSON_ID.test(id)) ? value as string[] : null;

function readKept(): Map<string, Kept> {
  const kept = new Map<string, Kept>();
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(CALL_ROSTERS_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return kept;
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry === null || typeof entry !== "object") continue;
      const { self, others, at } = entry as Record<string, unknown>;
      const selfIds = ids(self);
      const otherIds = ids(others);
      if (selfIds && otherIds && typeof at === "number" && Number.isFinite(at)) kept.set(id, { self: selfIds, others: otherIds, at });
    }
  } catch { /* Unreadable: as if nothing was kept. */ }
  return kept;
}

/** Keeps the ids of the people of recording `sourceId` (no names) on this device. Never throws. */
export function rememberCallRoster(sourceId: string, participants: CallParticipants, now = Date.now()): void {
  const roster = callRoster(participants);
  if (roster === null) return;
  try {
    const kept = readKept();
    kept.set(sourceId, { self: [...roster.self], others: [...roster.others], at: now });
    const fresh = [...kept].filter(([, entry]) => now - entry.at < KEEP_MS).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEPT);
    storage()?.setItem(CALL_ROSTERS_KEY, JSON.stringify(Object.fromEntries(fresh)));
  } catch { /* Storage may be full or off in a webview: the next transcript then keeps "Them". */ }
}

/** The ids kept for recording `sourceId`, or null. */
export function rememberedCallRoster(sourceId: string, now = Date.now()): CallRoster | null {
  const entry = readKept().get(sourceId);
  return entry !== undefined && now - entry.at < KEEP_MS ? { self: entry.self, others: entry.others } : null;
}

/** The people of recording `sourceId` by id: from the app's names file while it has them, else as kept here. */
export async function readCallRosterOnThisMac(sourceId: string): Promise<CallRoster | null> {
  const callNames = getDesktopCaptureExtras()?.callNames;
  if (callNames) {
    try {
      const participants = parseCallParticipants(await callNames.read(sourceId));
      if (participants !== null) {
        rememberCallRoster(sourceId, participants);
        return callRoster(participants);
      }
    } catch { /* The kept ids below, if any. */ }
  }
  return rememberedCallRoster(sourceId);
}

/**
 * `transcript` with each remote line named after the person the call window showed speaking (`assignCallSpeakers`),
 * or unchanged: on the Parakeet route, for a recording of one side, in a build without the timeline, when there is no
 * timeline or no people, and when the reads fail or take longer than `waitMs`. Never throws; logs no names.
 */
export async function nameCallSpeakersOnThisMac(note: Pick<VoiceNoteRecording, "id" | "channels">, transcript: LocalTranscript,
  waitMs = CALL_SPEAKERS_WAIT_MS): Promise<LocalTranscript> {
  if (note.channels !== 2 || !mayNameCallSpeakers(transcript.segments, transcript.engine)) return transcript;
  const callNames = getDesktopCaptureExtras()?.callNames;
  if (!callNames?.readSpeaking) return transcript;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timelineRead = callNames.readSpeaking(note.id);
    // The people are only a fallback for a timeline without its own order: a read of them that fails or is late is none.
    const rosterRead = readCallRosterOnThisMac(note.id).catch(() => null);
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), waitMs); });
    const timeline = await Promise.race([timelineRead, late]);
    if (timeline === "late") {
      // The read may still settle: nothing waits for it, and a late rejection is not reported.
      timelineRead.catch(() => undefined);
      logPipeline("call_speakers", note.id, "timed_out");
      return transcript;
    }
    if (timeline === null || timeline === undefined) return transcript;
    const people = await Promise.race([rosterRead, late]);
    const roster = people === "late" ? null : people;
    const named = assignCallSpeakers({ segments: transcript.segments, engine: transcript.engine, timeline, roster });
    logPipeline("call_speakers", note.id, named.assigned > 0 ? "named" : "none");
    return named.assigned > 0 ? { ...transcript, segments: named.segments } : transcript;
  } catch (error) {
    logPipelineError("call_speakers", error, note.id);
    return transcript;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
