// One automatic re-submit, on the next load, for a note whose private transcription ended
// because the speech-to-text provider failed (not because of the note). The re-submit is the
// user's own Retry (`transcriber.transcribe`), so it re-joins/creates the job through the same
// idempotent path. A per-note marker, kept on this device, makes it happen at most once ever:
// a second provider failure waits for the user's manual Retry.

import { accountStorageKey } from "./sourcePins";

/** Device-local, per account: the notes already re-submitted once automatically. */
export const VOICE_NOTE_AUTO_RESUBMITTED_KEY = "exo.voiceNotes.autoResubmitted";

/** The only failures re-submitted: PTX's provider outcomes (privateCloud.ts `provider_*` codes). Note-intrinsic failures (too_long, no_speech, invalid_audio ...) never are. */
export const PROVIDER_FAILURE_CODES: Readonly<Record<string, true>> = { provider_unavailable: true, provider_outcome_unknown: true };

/** A failure older than this is left for the user. */
export const AUTO_RESUBMIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Notes in line or running because of this pass at once. */
export const AUTO_RESUBMIT_MAX_IN_FLIGHT = 2;
/** Gap between two starts. */
export const AUTO_RESUBMIT_SPACING_MS = 1000;

export interface AutoResubmitStore {
  has(sourceId: string): boolean;
  /** True only when the marker is durably written; the note is not re-submitted otherwise. */
  mark(sourceId: string): boolean;
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export function memoryAutoResubmitStore(): AutoResubmitStore {
  const set = new Set<string>();
  return { has: (id) => set.has(id), mark: (id) => { set.add(id); return true; } };
}

export function localStorageAutoResubmitStore(
  accountDid: string,
  storage: KeyValueStorage | undefined = globalThis.localStorage,
): AutoResubmitStore {
  const key = accountStorageKey(VOICE_NOTE_AUTO_RESUBMITTED_KEY, accountDid);
  /** null: unreadable; an unreadable marker list never allows a re-submit. */
  const read = (): Record<string, number> | null => {
    try {
      const raw = storage?.getItem(key);
      if (raw === null || raw === undefined) return {};
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : null;
    } catch {
      return null;
    }
  };
  return {
    has: (id) => {
      const all = read();
      return all === null || id in all;
    },
    mark: (id) => {
      const all = read();
      if (all === null || !storage) return false;
      const next = JSON.stringify({ ...all, [id]: Date.now() });
      try {
        storage.setItem(key, next);
        return storage.getItem(key) === next;
      } catch {
        return false;
      }
    },
  };
}

export interface ProviderFailedNote {
  sourceId: string;
  /** The device-local terminal failure code. */
  code: string;
  /** When the failure was recorded; null for a failure recorded before that was kept. */
  failedAt: number | null;
}

export interface ResubmitRecording {
  startedAt: number;
}

/**
 * The notes to re-submit: provider-failed, never re-submitted, whose recording is still on this
 * device and whose failure is within 7 days. A failure with no recorded time is no older than its
 * recording, so the recording's age bounds it (a recording past the cutoff is left for the user).
 */
export function selectProviderResubmits(args: {
  failed: readonly ProviderFailedNote[];
  recordings: ReadonlyMap<string, ResubmitRecording>;
  marked: Pick<AutoResubmitStore, "has">;
  now: number;
}): string[] {
  return args.failed.flatMap(({ sourceId, code, failedAt }) => {
    if (PROVIDER_FAILURE_CODES[code] !== true || args.marked.has(sourceId)) return [];
    const recording = args.recordings.get(sourceId);
    if (!recording) return [];
    const since = failedAt ?? recording.startedAt;
    if (!Number.isFinite(since) || args.now - since > AUTO_RESUBMIT_MAX_AGE_MS) return [];
    return [sourceId];
  });
}
