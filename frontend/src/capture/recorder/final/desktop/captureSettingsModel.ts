import type {
  WhisperModelId,
  WhisperModelInfo,
} from "@/lib/voiceNotes/desktopCaptureExtras";

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
  | { type: "fail"; id: WhisperModelId; message: string }
  /** What `models.list()` says now: it is the truth for downloads under way and for models that finished. */
  | { type: "sync"; models: readonly WhisperModelInfo[] };

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
      // A "downloading" event after a failure is a new attempt (Retry, or another window); it replaces the error.
      return {
        ...state,
        [action.id]: {
          status: "downloading",
          fraction: clamp01(action.fraction),
        },
      };
    case "fail":
      return {
        ...state,
        [action.id]: { status: "error", message: action.message },
      };
    case "sync": {
      const next = { ...state };
      for (const model of action.models) {
        if (model.downloaded) delete next[model.id];
        else if (model.downloading) {
          const before = state[model.id];
          next[model.id] = {
            status: "downloading",
            fraction: clamp01(
              model.progress ??
                (before?.status === "downloading" ? before.fraction : 0),
            ),
          };
        }
      }
      return next;
    }
  }
}

export function progressPercent(fraction: number): number {
  return Math.round(clamp01(fraction) * 100);
}
