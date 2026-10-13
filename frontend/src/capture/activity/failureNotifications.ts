import type { AppPlatform } from "@/lib/platform";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { activityForNote, type ActivityKind } from "./activitySelector";
import { notePath } from "@/shell/routes";

export interface FailureNotification {
  key: string;
  noteId: string;
  track: ActivityKind;
  title: string;
  message: string;
  path: string;
}

// Keep diagnostics out of localStorage while allowing a changed failure to alert once.
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

export function failureNotifications(items: readonly LibraryItem[], views: ReadonlyMap<string, NotePipelineView>, platform: AppPlatform): FailureNotification[] {
  return items.flatMap((item) => {
    const jobs = activityForNote(views.get(item.sourceId), platform);
    return jobs.filter((job) => job.state === "needs-attention" && !(job.kind === "sync" && jobs.some((other) =>
      other.kind === "upload-audio" && other.state === "needs-attention" && other.diagnostics === job.diagnostics)))
    .map((job) => ({
      key: `${item.sourceId}:${job.kind}:${fingerprint(`${job.detail}\0${job.diagnostics ?? ""}`)}`,
      noteId: item.id,
      track: job.kind,
      title: item.snippet ?? item.title ?? "Voice note",
      message: job.detail,
      path: notePath(item.id),
    }));
  });
}

export class FailureNotificationDedupe {
  private seen: Set<string>;
  constructor(keys: readonly string[] = []) { this.seen = new Set(keys); }
  take(failures: readonly FailureNotification[], visibleNoteId: string | null): FailureNotification[] {
    const newFailures: FailureNotification[] = [];
    for (const failure of failures) {
      if (this.seen.has(failure.key)) continue;
      this.seen.add(failure.key);
      if (failure.noteId !== visibleNoteId) newFailures.push(failure);
    }
    return newFailures;
  }
  keys(): string[] { return [...this.seen].slice(-500); }
}
