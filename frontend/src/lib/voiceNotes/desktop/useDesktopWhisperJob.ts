import { useSyncExternalStore } from "react";
import { getDesktopWhisperQueue, type DesktopWhisperJob } from "./desktopWhisper";

const noop = () => undefined;

/** One note's after-stop Whisper job on this Mac (queued, transcribing, done, failed); null when it has none or there is no queue. */
export function useDesktopWhisperJob(id: string | null): DesktopWhisperJob | null {
  const read = () => (id === null ? null : getDesktopWhisperQueue()?.snapshot().get(id) ?? null);
  return useSyncExternalStore((listener) => getDesktopWhisperQueue()?.subscribe(listener) ?? noop, read, read);
}
