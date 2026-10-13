import { expect, test } from "bun:test";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { nativeFailurePayload } from "./FailureNotificationHost";
import { FailureNotificationDedupe, failureNotifications } from "./failureNotifications";

const item: LibraryItem = { id: "library/note 1", sourceId: "note-1", source: "exo-voice-note", title: "Voice note", startedAt: "2026-10-13T11:00:00Z", durationSecs: 60 };
function view(failed: boolean): NotePipelineView {
  const input: NotePipelineInput = { device: "mac", route: "off", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: !failed, pending: failed ? { failed: { kind: "timeout", message: "service timed out" } } : null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, cloud: null, onDevice: null }, notes: { state: "idle" } };
  return { input, pipeline: notePipeline(input), provider: "unknown", onAction: () => {}, actionError: null };
}

function cloudFailure(reference: string): NotePipelineView {
  const input: NotePipelineInput = { device: "mac", route: "private-cloud", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, cloud: { kind: "failed", code: "server_error", message: `request ${reference} failed`, retryable: true, reference }, onDevice: null },
    notes: { state: "idle" } };
  return { input, pipeline: notePipeline(input), provider: "private", onAction: () => {}, actionError: null };
}

test("success never creates a notification", () => {
  expect(failureNotifications([item], new Map([[item.sourceId, view(false)]]), "web")).toEqual([]);
});

test("a failure alerts once across repeated projections and a restored dedupe set", () => {
  const failures = failureNotifications([item], new Map([[item.sourceId, view(true)]]), "tauri");
  expect(failures).toHaveLength(1);
  const dedupe = new FailureNotificationDedupe();
  expect(dedupe.take(failures, null)).toHaveLength(1);
  expect(dedupe.take(failures, null)).toEqual([]);
  expect(new FailureNotificationDedupe(dedupe.keys()).take(failures, null)).toEqual([]);
});

test("a failure seen while its note is on screen stays suppressed after leaving", () => {
  const failures = failureNotifications([item], new Map([[item.sourceId, view(true)]]), "ios");
  const dedupe = new FailureNotificationDedupe();
  expect(dedupe.take(failures, item.id)).toEqual([]);
  expect(dedupe.take(failures, null)).toEqual([]);
});

test("the same failure class across retries with different request IDs notifies once", () => {
  const first = failureNotifications([item], new Map([[item.sourceId, cloudFailure("ref-1")]]), "tauri");
  const second = failureNotifications([item], new Map([[item.sourceId, cloudFailure("ref-2")]]), "tauri");
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0]!.key).toBe(second[0]!.key);
  expect(first[0]!.key).not.toContain("ref-1");
  const dedupe = new FailureNotificationDedupe();
  expect(dedupe.take(first, null)).toHaveLength(1);
  expect(new FailureNotificationDedupe(dedupe.keys()).take(second, null)).toEqual([]);
});

test("more than 500 consumed failures remain suppressed after a restart", () => {
  const failures = Array.from({ length: 502 }, (_, index) => ({
    key: JSON.stringify([`note-${index}`, "sync", "timeout"]), noteId: `note-${index}`,
    track: "sync" as const, title: "Voice note", message: "Saving timed out", path: `/note/${index}`,
  }));
  const dedupe = new FailureNotificationDedupe();
  expect(dedupe.take(failures, null)).toHaveLength(502);
  expect(dedupe.keys()).toHaveLength(502);
  const restoredKeys: string[] = JSON.parse(JSON.stringify(dedupe.keys()));
  expect(new FailureNotificationDedupe(restoredKeys).take(failures, null)).toEqual([]);
});

test("the native payload deep-links to the encoded note and identifies its track", () => {
  const [failure] = failureNotifications([item], new Map([[item.sourceId, view(true)]]), "tauri");
  expect(nativeFailurePayload(failure!)).toEqual({ path: "/chat/capture/library/library%2Fnote%201", noteId: item.id, track: "sync" });
});
