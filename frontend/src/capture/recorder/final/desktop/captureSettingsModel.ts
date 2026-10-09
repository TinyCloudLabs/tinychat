import type { WhisperModelId } from "@/lib/voiceNotes/desktopCaptureExtras";

/** "44 MB", "874 MB", "1.2 GB": decimal units, as the downloads are quoted. */
export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0)
    throw new RangeError("bytes must be a non-negative finite number");
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export type DownloadState =
  | { status: "downloading"; fraction: number }
  | { status: "error"; message: string };

export type Downloads = Partial<Record<WhisperModelId, DownloadState>>;

export type DownloadAction =
  | { type: "start"; id: WhisperModelId }
  | { type: "progress"; id: WhisperModelId; fraction: number }
  | { type: "done"; id: WhisperModelId }
  | { type: "fail"; id: WhisperModelId; message: string };

const clamp01 = (fraction: number) =>
  Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;

export function downloadsReducer(
  state: Downloads,
  action: DownloadAction,
): Downloads {
  switch (action.type) {
    case "start":
      return { ...state, [action.id]: { status: "downloading", fraction: 0 } };
    case "progress":
      // A failed row stays failed until Retry; a late event must not hide the error.
      if (state[action.id]?.status === "error") return state;
      return {
        ...state,
        [action.id]: {
          status: "downloading",
          fraction: clamp01(action.fraction),
        },
      };
    case "done": {
      const { [action.id]: _finished, ...rest } = state;
      return rest;
    }
    case "fail":
      return {
        ...state,
        [action.id]: { status: "error", message: action.message },
      };
  }
}

export function progressPercent(fraction: number): number {
  return Math.round(clamp01(fraction) * 100);
}
