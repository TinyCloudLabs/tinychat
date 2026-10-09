import { useContext, useEffect, useMemo } from "react";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { formatDuration } from "../../recorderCopy";
import type { RecorderPhase } from "../../recorderReducer";
import { useRecorder } from "../../RecorderProvider";
import { useRecordedElapsed } from "../../useRecordedElapsed";
import type { MicState } from "@/lib/voiceNotes/nativeVoiceNotes";

/** The title while recording ("● 0:42 · Exo"), paused ("❚❚ 0:42 · Exo"), or null when there is nothing to show. */
export function recordingTitle(phase: RecorderPhase, micState: MicState, elapsedMs: number): string | null {
  if (phase !== "recording") return null;
  return `${micState === "paused" ? "❚❚" : "●"} ${formatDuration(elapsedMs)} · Exo`;
}

/** Where the title lives: the tab on the web, the window in the desktop app. */
export interface TitleTarget {
  read(): string | Promise<string>;
  write(title: string): void | Promise<void>;
}

export const documentTitleTarget: TitleTarget = {
  read: () => document.title,
  write: (title) => {
    document.title = title;
  },
};

export const tauriWindowTitleTarget: TitleTarget = {
  // Lazy: @tauri-apps/api must never enter the web bundle's main chunk.
  read: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().title(),
  write: async (title) => {
    await (await import("@tauri-apps/api/window")).getCurrentWindow().setTitle(title);
  },
};

/** The phone apps have no title to set. */
export function titleTargetFor(platform: AppPlatform): TitleTarget | null {
  if (platform === "web") return documentTitleTarget;
  if (platform === "tauri") return tauriWindowTitleTarget;
  return null;
}

const logTitleFailure = (caught: unknown) => console.error("[Recorder] Could not set the recording title", caught);

/**
 * Applies a title and puts back the one it replaced, in order, so a slow window call cannot
 * overtake a later one. A failed call is logged, never swallowed.
 */
export function createTitleController(target: TitleTarget, onError: (caught: unknown) => void = logTitleFailure) {
  let saved: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  return {
    /** A title while recording, or null to restore the one from before. */
    apply(title: string | null): void {
      queue = queue
        .then(async () => {
          if (title !== null) {
            if (saved === null) saved = await target.read();
            await target.write(title);
          } else if (saved !== null) {
            const previous = saved;
            saved = null;
            await target.write(previous);
          }
        })
        .catch(onError);
    },
  };
}

/** The single owner of the recording title. Time comes from the recorder's timestamps; the title changes about once a second. */
export function useRecordingTitle(target?: TitleTarget | null): void {
  const recorder = useRecorder();
  const platform = useContext(PlatformContext);
  const elapsedMs = useRecordedElapsed(recorder.elapsedMs, recorder);
  const title = recordingTitle(recorder.phase, recorder.mic.state, elapsedMs);
  const resolved = target === undefined ? titleTargetFor(platform) : target;
  const controller = useMemo(() => (resolved ? createTitleController(resolved) : null), [resolved]);
  useEffect(() => {
    controller?.apply(title);
  }, [controller, title]);
  useEffect(() => () => controller?.apply(null), [controller]);
}
