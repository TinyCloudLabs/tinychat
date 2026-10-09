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

/** The picker's two halves: models on disk are the radiogroup, the rest are plain rows with Get. */
export function partitionModels(
  models: readonly WhisperModelInfo[],
  selected: WhisperModelId | null,
): {
  radios: WhisperModelInfo[];
  available: WhisperModelInfo[];
  /** The radio that holds the tab stop: the checked one, else the first. Null when there is no radio. */
  tabStop: WhisperModelId | null;
} {
  const radios = models.filter((m) => m.downloaded);
  return {
    radios,
    available: models.filter((m) => !m.downloaded),
    tabStop: (radios.find((m) => m.id === selected) ?? radios[0])?.id ?? null,
  };
}

/** The radio an arrow key reaches from `from`, wrapping. Null when `from` is not a radio. */
export function adjacentRadio(
  radios: readonly WhisperModelInfo[],
  from: string | null | undefined,
  direction: 1 | -1,
): WhisperModelInfo | null {
  const at = radios.findIndex((m) => m.id === from);
  if (at < 0) return null;
  return radios[(at + direction + radios.length) % radios.length] ?? null;
}

/** Where focus goes when a row changes shape under it. */
export type FocusTarget = {
  id: WhisperModelId;
  to: "progress" | "radio" | "retry";
};

/** Activating Get or Retry: the button is replaced by the row's progress element. */
export const focusAfterGet = (id: WhisperModelId): FocusTarget => ({
  id,
  to: "progress",
});

/** `focusedProgress`: the model whose progress element has focus right now, if any. */
export function focusAfterSync(
  focusedProgress: WhisperModelId | null,
  models: readonly WhisperModelInfo[],
): FocusTarget | null {
  if (focusedProgress === null) return null;
  return models.some((m) => m.id === focusedProgress && m.downloaded)
    ? { id: focusedProgress, to: "radio" }
    : null;
}

export function focusAfterFail(
  focusedProgress: WhisperModelId | null,
  failed: WhisperModelId,
): FocusTarget | null {
  return focusedProgress === failed ? { id: failed, to: "retry" } : null;
}

/** Models that were not on disk in `before` and are in `after`: what to announce. Nothing without a `before`. */
export function newlyDownloaded(
  before: readonly WhisperModelInfo[] | null,
  after: readonly WhisperModelInfo[],
): WhisperModelInfo[] {
  if (before === null) return [];
  return after.filter(
    (m) => m.downloaded && before.some((b) => b.id === m.id && !b.downloaded),
  );
}

export const downloadedAnnouncement = (labels: readonly string[]) =>
  `${labels.join(" and ")} downloaded`;

export const progressText = (fraction: number) =>
  `Downloading, ${progressPercent(fraction)}%`;
