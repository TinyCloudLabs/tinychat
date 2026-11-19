import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { installDom } from "@/test/dom";
import type { LibraryItem } from "../library/LibraryRow";
import { FailureNotificationHost } from "./FailureNotificationHost";
import { failureNotificationStorageKey } from "./failureNotifications";

const items: LibraryItem[] = ["A", "B"].map((id) => ({
  id, sourceId: id, source: "exo-voice-note", title: `Note ${id}`,
  startedAt: "2026-10-13T11:00:00Z", durationSecs: 60,
}));

function view(failed: boolean): NotePipelineView {
  const input: NotePipelineInput = {
    device: "mac", route: "off", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: !failed, pending: failed ? { failed: { kind: "timeout", message: "timed out" } } : null,
      lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, cloud: null, onDevice: null }, notes: { state: "idle" },
  };
  return { input, pipeline: notePipeline(input), provider: "unknown", onAction: () => {}, actionError: null };
}

test("host persists a same-size episode replacement before restart", async () => {
  const restoreDom = installDom();
  const values = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  const host = document.createElement("div");
  document.body.append(host);
  const accountDid = "did:host-episode-replacement";
  const storageKey = failureNotificationStorageKey(accountDid);
  const props = { accountDid, items, platform: "web" as const, visibleNoteId: null, onOpenPath: () => {} };
  let root = createRoot(host);
  try {
    await act(async () => root.render(<FailureNotificationHost {...props} views={new Map([["A", view(true)], ["B", view(false)]])} />));
    expect(JSON.parse(values.get(storageKey)!)).toEqual([JSON.stringify(["A", "sync", "network"])]);

    await act(async () => root.render(<FailureNotificationHost {...props} views={new Map([["A", view(false)], ["B", view(true)]])} />));
    expect(JSON.parse(values.get(storageKey)!)).toEqual([JSON.stringify(["B", "sync", "network"])]);

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<FailureNotificationHost {...props} views={new Map([["A", view(false)], ["B", view(true)]])} />));
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    restoreDom();
  }
});
