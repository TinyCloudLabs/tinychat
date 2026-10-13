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

test("the native payload deep-links to the encoded note and identifies its track", () => {
  const [failure] = failureNotifications([item], new Map([[item.sourceId, view(true)]]), "tauri");
  expect(nativeFailurePayload(failure!)).toEqual({ path: "/chat/capture/library/library%2Fnote%201", noteId: item.id, track: "sync" });
});
