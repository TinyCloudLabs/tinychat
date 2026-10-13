import { expect, spyOn, test } from "bun:test";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { nativeFailurePayload } from "./FailureNotificationHost";
import { FailureNotificationDedupe, failureNotifications, failureNotificationStorageKey, pruneDeletedFailureNotification, readFailureNotificationKeys, writeFailureNotificationKeys } from "./failureNotifications";

const item: LibraryItem = { id: "library/note 1", sourceId: "note-1", source: "exo-voice-note", title: "Voice note", startedAt: "2026-10-13T11:00:00Z", durationSecs: 60 };
function withStorage(run: () => void): void {
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try { run(); }
  finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
}
function view(failed: boolean): NotePipelineView {
  const input: NotePipelineInput = { device: "mac", route: "off", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: !failed, pending: failed ? { failed: { kind: "timeout", message: "service timed out" } } : null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, cloud: null, onDevice: null }, notes: { state: "idle" } };
  return { input, pipeline: notePipeline(input), provider: "unknown", onAction: () => {}, actionError: null };
}

function cloudFailure(reference: string, code = "server_error"): NotePipelineView {
  const input: NotePipelineInput = { device: "mac", route: "private-cloud", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, cloud: { kind: "failed", code, message: `request ${reference} failed`, retryable: true, reference }, onDevice: null },
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
    key: JSON.stringify([`note-${index}`, "sync", "network"]), noteId: `note-${index}`,
    track: "sync" as const, title: "Voice note", message: "Saving timed out", path: `/note/${index}`,
  }));
  const dedupe = new FailureNotificationDedupe();
  expect(dedupe.take(failures, null)).toHaveLength(502);
  expect(dedupe.keys()).toHaveLength(502);
  const restoredKeys: string[] = JSON.parse(JSON.stringify(dedupe.keys()));
  expect(new FailureNotificationDedupe(restoredKeys).take(failures, null)).toEqual([]);
});

test("502 distinct provider codes occupy one class-bounded key for one note and track", () => {
  const dedupe = new FailureNotificationDedupe();
  for (let index = 0; index < 502; index++) {
    const failures = failureNotifications([item], new Map([[item.sourceId, cloudFailure(`ref-${index}`, `arbitrary_${index}`)]]), "tauri");
    expect(dedupe.take(failures, null)).toHaveLength(index === 0 ? 1 : 0);
  }
  expect(dedupe.keys()).toEqual([JSON.stringify([item.sourceId, "transcribe", "unknown"])]);
  expect(new FailureNotificationDedupe(dedupe.keys()).keys()).toHaveLength(1);
  const legacyKeys = Array.from({ length: 502 }, (_, index) => JSON.stringify([item.sourceId, "transcribe", `arbitrary_${index}`]));
  expect(new FailureNotificationDedupe(legacyKeys).keys()).toHaveLength(1);
  withStorage(() => {
    const key = failureNotificationStorageKey("did:bounded-codes-test");
    writeFailureNotificationKeys(key, dedupe.keys());
    expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(1);
  });
});

test("a changing code in one continuous failure episode stays consumed", () => {
  const dedupe = new FailureNotificationDedupe();
  const first = failureNotifications([item], new Map([[item.sourceId, cloudFailure("ref-1", "server_error")]]), "tauri");
  const secondView = new Map([[item.sourceId, cloudFailure("ref-2", "provider_unavailable")]]);
  expect(dedupe.take(first, null)).toHaveLength(1);
  dedupe.reconcile(secondView, "tauri");
  expect(dedupe.take(failureNotifications([item], secondView, "tauri"), null)).toEqual([]);
  expect(dedupe.keys()).toHaveLength(1);
});

test("fail, success, fail on one track notifies twice", () => {
  const dedupe = new FailureNotificationDedupe();
  const failed = failureNotifications([item], new Map([[item.sourceId, view(true)]]), "tauri");
  expect(dedupe.take(failed, null)).toHaveLength(1);
  dedupe.reconcile(new Map([[item.sourceId, view(false)]]), "tauri");
  expect(dedupe.keys()).toEqual([]);
  expect(dedupe.take(failed, null)).toHaveLength(1);
});

test("a partial Library page keeps consumed keys; confirmed deletion prunes them", () => {
  withStorage(() => {
    const account = "did:partial-page-test";
    const storageKey = failureNotificationStorageKey(account);
    const dedupe = new FailureNotificationDedupe();
    const failed = failureNotifications([item], new Map([[item.sourceId, view(true)]]), "tauri");
    dedupe.take(failed, null);
    writeFailureNotificationKeys(storageKey, dedupe.keys());
    dedupe.reconcile(new Map(), "tauri"); // The partial page has no view for this note.
    expect(dedupe.keys()).toHaveLength(1);
    expect(readFailureNotificationKeys(storageKey)).toHaveLength(1);
    pruneDeletedFailureNotification(account, item.sourceId);
    expect(readFailureNotificationKeys(storageKey)).toEqual([]);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([]);
  });
});

test("storage write failures keep session keys and are logged", () => {
  const key = failureNotificationStorageKey("did:storage-failure-test");
  const storage = globalThis.localStorage;
  const log = spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: () => { throw new Error("quota"); }, getItem: () => null } });
  try {
    writeFailureNotificationKeys(key, ["consumed"]);
    expect(readFailureNotificationKeys(key)).toEqual(["consumed"]);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    if (storage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    log.mockRestore();
  }
});

test("the native payload deep-links to the encoded note and identifies its track", () => {
  const [failure] = failureNotifications([item], new Map([[item.sourceId, view(true)]]), "tauri");
  expect(nativeFailurePayload(failure!)).toEqual({ path: "/chat/capture/library/library%2Fnote%201", noteId: item.id, track: "sync" });
});
