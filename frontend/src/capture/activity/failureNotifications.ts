import type { AppPlatform } from "@/lib/platform";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { activityForNote, type ActivityKind } from "./activitySelector";
import { notePath } from "@/shell/routes";

type FailureClass = "network" | "server" | "auth" | "quota" | "too_large" | "provider" | "local_engine" | "storage" | "unknown";

/** Only these fixed classes enter persisted keys; provider supplied codes may be arbitrary strings. */
export function failureClass(code: string | undefined): FailureClass {
  const value = code?.toLowerCase() ?? "";
  if (/^(offline|timeout|network(_error)?|upload_interrupted|upload_outcome_unknown)$/.test(value)) return "network";
  if (/^(server(_error)?|service_busy|service_paused|upstream_bad_response|transcript_sync_failed|transcript-sync-failed)$/.test(value)) return "server";
  if (/^(auth|auth_unauthorized|unauthorized|forbidden|signed-out|other-account)$/.test(value)) return "auth";
  if (/^(quota|storage_quota_exceeded)$/.test(value)) return "quota";
  if (/^(too_large|recording_too_large|recording_too_long|voice_note_audio_too_large)$/.test(value)) return "too_large";
  if (/^(provider|provider_unavailable|invalid_audio|no_speech|transcript_save_failed)$/.test(value)) return "provider";
  if (/^(local_engine|on-device-stt|model_unavailable|transcription_failed|finalization_timed_out)$/.test(value)) return "local_engine";
  if (/^(storage|store_error|write_failed|read-error|source|voice_note_source_read_failed|transcript-unrecorded|unreadable)$/.test(value)) return "storage";
  return "unknown";
}

const failureKey = (sourceId: string, track: ActivityKind, code?: string): string =>
  JSON.stringify([sourceId, track, failureClass(code)]);

function keyParts(key: string): [string, ActivityKind, string] | null {
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== "string" ||
      !["finish", "transcribe", "sync", "upload-audio"].includes(parts[1]) || typeof parts[2] !== "string") return null;
    return [parts[0], parts[1] as ActivityKind, parts[2]];
  } catch { return null; }
}

export interface FailureNotification {
  key: string;
  noteId: string;
  track: ActivityKind;
  title: string;
  message: string;
  path: string;
}

export function failureNotifications(items: readonly LibraryItem[], views: ReadonlyMap<string, NotePipelineView>, platform: AppPlatform): FailureNotification[] {
  return items.flatMap((item) => {
    const jobs = activityForNote(views.get(item.sourceId), platform);
    return jobs.filter((job) => job.state === "needs-attention" && !(job.kind === "sync" && jobs.some((other) =>
      other.kind === "upload-audio" && other.state === "needs-attention" && other.diagnostics === job.diagnostics)))
    .map((job) => ({
      key: failureKey(item.sourceId, job.kind, job.failureCode),
      noteId: item.id,
      track: job.kind,
      title: item.snippet ?? item.title ?? "Voice note",
      message: job.detail,
      path: notePath(item.id),
    }));
  });
}

export class FailureNotificationDedupe {
  private seen = new Map<string, string>();
  constructor(keys: readonly string[] = []) {
    for (const key of keys) {
      const parts = keyParts(key);
      if (parts) {
        const trackKey = JSON.stringify([parts[0], parts[1]]);
        if (!this.seen.has(trackKey)) this.seen.set(trackKey, failureKey(parts[0], parts[1], parts[2]));
      }
    }
  }
  /** A note × track is consumed for one failure episode. A known success or cleared failure rearms it; an absent Library row says nothing. */
  reconcile(views: ReadonlyMap<string, NotePipelineView>, platform: AppPlatform): void {
    for (const [sourceId, view] of views) {
      if (!view?.input) continue;
      const failing = new Set(activityForNote(view, platform).filter((job) => job.state === "needs-attention").map((job) => job.kind));
      for (const [trackKey, key] of this.seen) {
        const parts = keyParts(key);
        if (parts?.[0] === sourceId && !failing.has(parts[1])) this.seen.delete(trackKey);
      }
    }
  }
  /** Call only after an explicit delete or confirmed tombstone, never after a partial Library listing. */
  pruneDeleted(sourceId: string): void {
    for (const [trackKey, key] of this.seen) if (keyParts(key)?.[0] === sourceId) this.seen.delete(trackKey);
  }
  take(failures: readonly FailureNotification[], visibleNoteId: string | null): FailureNotification[] {
    const newFailures: FailureNotification[] = [];
    for (const failure of failures) {
      const parts = keyParts(failure.key);
      if (!parts) continue;
      const trackKey = JSON.stringify([parts[0], parts[1]]);
      if (this.seen.has(trackKey)) continue;
      this.seen.set(trackKey, failure.key);
      if (failure.noteId !== visibleNoteId) newFailures.push(failure);
    }
    return newFailures;
  }
  keys(): string[] { return [...this.seen.values()]; }
}

export const failureNotificationStorageKey = (accountDid: string): string => `exo-failure-notifications-v2:${accountDid}`;
const sessionKeys = new Map<string, string[]>();

export function readFailureNotificationKeys(key: string): string[] {
  const session = sessionKeys.get(key);
  if (session) return session;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

export function writeFailureNotificationKeys(key: string, keys: string[]): void {
  sessionKeys.set(key, keys);
  try { if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(keys)); }
  catch (error) { console.error("Failure notifications: could not persist consumed keys; keeping them for this session", error); }
}

/** The caller has confirmed the note's deletion or tombstone. A partial Library page must never call this. */
export function pruneDeletedFailureNotification(accountDid: string, sourceId: string): void {
  const key = failureNotificationStorageKey(accountDid);
  const dedupe = new FailureNotificationDedupe(readFailureNotificationKeys(key));
  dedupe.pruneDeleted(sourceId);
  writeFailureNotificationKeys(key, dedupe.keys());
}
