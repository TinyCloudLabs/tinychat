// Read-only views over `onDeviceSttStore`'s native queue. The queue is in running/FIFO order; entries that
// finished (done, failed, cancelled) stay listed but are not "in line".
import type { OnDeviceSttStatus } from "./onDeviceStt";

export type OnDeviceQueueEntry = OnDeviceSttStatus["queue"][number];

export interface OnDeviceQueuePlace {
  entry: OnDeviceQueueEntry;
  /** 1-based place among the notes still in line (waiting for the model, queued, or running); null once the entry finished. */
  position: number | null;
  /** How many notes are still in line. */
  inLine: number;
  /** The running job's 0..100 progress; null until it reports one or while it is not running. */
  percent: number | null;
}

const IN_LINE: ReadonlySet<OnDeviceQueueEntry["state"]> = new Set(["waiting_for_model", "queued", "running"]);

export function onDeviceQueuePlace(status: Pick<OnDeviceSttStatus, "queue">, id: string): OnDeviceQueuePlace | null {
  const entry = status.queue.find((job) => job.id === id);
  if (!entry) return null;
  const line = status.queue.filter((job) => IN_LINE.has(job.state));
  const index = line.indexOf(entry);
  return {
    entry,
    position: index === -1 ? null : index + 1,
    inLine: line.length,
    percent: entry.state === "running" ? entry.percent : null,
  };
}
