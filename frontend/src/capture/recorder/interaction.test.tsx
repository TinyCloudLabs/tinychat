import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";

import { installDom } from "@/test/dom";
import { SoftCaptureHome } from "../home/SoftCaptureHome";
import { SoftHomeProvider } from "../home/softHome";
import { LibraryRow, type LibraryItem } from "../library/LibraryRow";
import type { InProgressRowsViewProps } from "../InProgressRows";
import type { MomentFlow } from "./final/momentController";
import { MomentField } from "./final/MomentField";

let cleanupDom: (() => void) | undefined;
afterEach(() => { cleanupDom?.(); cleanupDom = undefined; });

const noop = () => {};
const now = new Date(2026, 9, 9, 9, 41);
const inProgress: InProgressRowsViewProps = {
  upload: null, paused: null, meetings: [], busyId: null,
  onOpenUpload: noop, onContinue: noop, onOpenMeeting: noop, onEnd: noop,
};
const recentNote: LibraryItem = {
  id: "on-phone:rec-2", source: "exo-voice-note", sourceId: "rec-2", title: null,
  startedAt: "2026-10-09T01:48:00.000Z", durationSecs: 125, onPhone: true,
};
const savingNote: LibraryItem = {
  id: "row-saving", source: "exo-voice-note", sourceId: "rec-saving", title: "Saving note",
  startedAt: "2026-10-09T01:48:00.000Z", durationSecs: 125, saving: true,
};

async function mounted(host: HTMLElement, tree: React.ReactNode): Promise<Root> {
  const root = createRoot(host);
  await act(async () => root.render(tree));
  return root;
}

describe("dogfood interaction regressions", () => {
  test("Android Back closes a note sheet first and minimizes only on the recorder surface", async () => {
    cleanupDom = installDom();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const [{ minimizePhoneRecorder }, { SheetDialog }, { topOverlay, dismissOverlay }] = await Promise.all([
      import("./RecordingOverlay"), import("./final/SheetDialog"), import("@/shell/useAndroidBack"),
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    let minimized = 0;
    let closed = 0;
    let committed = 0;
    let cancelled = 0;
    let draft = "";
    const flow = {
      isOpen: () => true,
      type: (value: string) => { draft = value; },
      commit: () => { committed++; },
      cancel: () => { cancelled++; },
    } as unknown as MomentFlow;
    function BackHarness() {
      const [open, setOpen] = useState(true);
      const opener = useRef<HTMLElement>(null);
      const fallback = useRef<HTMLElement>(null);
      return createElement("div", {
        "data-testid": "recording-overlay", "data-overlay-open": "true",
        onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => minimizePhoneRecorder(event.nativeEvent, () => { minimized++; }),
      }, open ? createElement(SheetDialog, {
        role: "dialog", title: "Notes", description: "Note sheet", titleId: "notes-title", descriptionId: "notes-description",
        onCancel: () => { closed++; setOpen(false); }, returnFocus: opener, fallbackFocus: fallback,
        children: createElement("p", null, "Notes stay saved while the sheet closes"),
      }) : createElement(MomentField, {
        field: { time: "0:12" }, flow, onClosed: () => {},
      }));
    }
    const root = await mounted(host, createElement(BackHarness));
    const inner = topOverlay()!;
    expect(inner.classList.contains("pr-sheet")).toBe(true);
    await act(async () => dismissOverlay(inner));
    expect(closed).toBe(1);
    expect(minimized).toBe(0);
    const recorder = document.querySelector<HTMLElement>('[data-testid="recording-overlay"]')!;
    const moment = recorder.querySelector("input")!;
    moment.focus();
    Object.getOwnPropertyDescriptor(moment.constructor.prototype, "value")?.set?.call(moment, "follow up with Sam");
    await act(async () => moment.dispatchEvent(new InputEvent("input", { bubbles: true, data: "follow up with Sam", inputType: "insertText" })));
    await act(async () => dismissOverlay(recorder));
    expect(committed).toBe(1);
    expect(cancelled).toBe(0);
    expect(draft).toBe("follow up with Sam");
    expect(document.activeElement).not.toBe(moment);
    expect(minimized).toBe(0);
    recorder.focus();
    await act(async () => dismissOverlay(recorder));
    expect(minimized).toBe(1);
    await act(async () => root.unmount());
    host.remove();
  });

  test("Gboard confirms composition with 229, then composing Enter 13 saves", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let open = true;
    const commits: string[] = [];
    const flow = {
      isOpen: () => open,
      type: noop,
      commit: () => { commits.push("saved"); open = false; },
      cancel: noop,
    } as unknown as MomentFlow;
    const closed: string[] = [];
    await act(async () => root.render(createElement(MomentField, {
      field: { time: "0:12" }, flow, onClosed: (result: string) => closed.push(result),
    })));
    const input = host.querySelector("input")!;
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "に" }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    });
    expect(commits).toEqual([]);
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "に" }));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "に", inputType: "insertText" }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, isComposing: true, bubbles: true, cancelable: true }));
    });
    expect(commits).toEqual(["saved"]);
    expect(closed).toEqual(["saved"]);
    await act(async () => root.unmount());
    host.remove();
  });

  test("a physical Escape still cancels the real moment field", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let committed = 0;
    let cancelled = 0;
    const flow = {
      isOpen: () => true,
      type: noop,
      commit: () => { committed++; },
      cancel: () => { cancelled++; },
    } as unknown as MomentFlow;
    await act(async () => root.render(createElement(MomentField, {
      field: { time: "0:12" }, flow, onClosed: noop,
    })));
    const input = host.querySelector("input")!;
    input.focus();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(committed).toBe(0);
    expect(cancelled).toBe(1);
    await act(async () => root.unmount());
    host.remove();
  });

  test("a Recent row with a recovery issue activates issue details instead of Recent note navigation", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    let openedRecent = 0;
    const root = await mounted(host, createElement(BrowserRouter, null,
      createElement(SoftHomeProvider, {
        enabled: true,
        issues: { "rec-2": { kind: "recoveryFailed", detail: "disk unavailable" } },
        onDismissIssue: () => true,
      },
        createElement(LibraryRow, {
          item: recentNote, now, grouped: false, onRecentOpen: () => { openedRecent++; },
        }),
      ),
    ));
    const row = host.querySelector<HTMLButtonElement>(".soft-row")!;
    expect(row.getAttribute("aria-label")).toContain("Couldn't recover this recording");
    expect(row.getAttribute("aria-label")).toContain("Opens details");
    expect(host.querySelector('[data-issue="recoveryFailed"]')).not.toBeNull();
    await act(async () => row.click());
    expect(openedRecent).toBe(0);
    expect(row.isConnected).toBe(true);
    await act(async () => root.unmount());
    host.remove();
  });

  test("Recent on-phone tap opens its sheet; browser Back closes it and keeps Capture visible", async () => {
    cleanupDom = installDom();
    window.history.replaceState(null, "", "/chat/capture");
    const { RecentNotePendingSheet } = await import("../library/RecentNotePendingSheet");
    function CaptureRecentHarness() {
      const navigate = useNavigate();
      const location = useLocation();
      const [selectedId, setSelectedId] = useState<string | null>(null);
      useEffect(() => {
        const id = (location.state as { recentNoteSheet?: unknown } | null)?.recentNoteSheet;
        setSelectedId(typeof id === "string" ? id : null);
      }, [location.key, location.state]);
      useEffect(() => {
        const id = (location.state as { recentNoteSheet?: unknown } | null)?.recentNoteSheet;
        setSelectedId(typeof id === "string" ? id : null);
      }, [location.key, location.state]);
      return createElement("div", { "data-selected-recent-id": selectedId ?? "" },
        createElement("h1", { "data-testid": "capture-home-heading" }, "Capture"),
        createElement(SoftHomeProvider, { enabled: true, issues: {}, onDismissIssue: () => true },
          createElement(SoftCaptureHome, {
            inProgress, recent: { status: "ready", items: [recentNote, savingNote] }, scanFailure: null,
            onRetryRecent: noop, now,
            onOpenRecentNote: (id: string) => {
              setSelectedId(id);
              navigate(location.pathname, { state: { recentNoteSheet: id } });
            },
          }),
        ),
        selectedId !== null && createElement(RecentNotePendingSheet, {
          listing: true, failed: false, onRetry: noop,
          onClose: () => navigate(-1),
        }),
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = await mounted(host, createElement(BrowserRouter, null, createElement(CaptureRecentHarness)));
    const row = host.querySelector<HTMLButtonElement>('[data-testid="recent-item"] button')!;
    await act(async () => row.click());
    expect(host.querySelector("[data-selected-recent-id]")?.getAttribute("data-selected-recent-id")).toBe(recentNote.id);
    expect(document.querySelector('[data-testid="recent-note-sheet"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="capture-home-heading"]')?.textContent).toBe("Capture");
    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[data-testid="recent-note-sheet"]')).toBeNull();
    expect(document.querySelector('[data-testid="capture-home-heading"]')?.textContent).toBe("Capture");
    const savingRow = host.querySelectorAll<HTMLButtonElement>('[data-testid="recent-item"] button')[1]!;
    await act(async () => savingRow.click());
    expect(host.querySelector("[data-selected-recent-id]")?.getAttribute("data-selected-recent-id")).toBe(savingNote.id);
    expect(document.querySelector('[data-testid="recent-note-sheet"]')).not.toBeNull();
    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[data-testid="recent-note-sheet"]')).toBeNull();
    await act(async () => root.unmount());
    let retries = 0;
    const retryRoot = createRoot(host);
    await act(async () => retryRoot.render(createElement(RecentNotePendingSheet, {
      listing: false, failed: true, onRetry: () => { retries++; }, onClose: noop,
    })));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load this note");
    expect(document.activeElement).toBe(document.querySelector("[data-recent-retry]"));
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(document.querySelector("[data-recent-close]"));
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(document.querySelector("[data-recent-retry]"));
    await act(async () => (document.querySelector('[data-testid="recent-note-sheet"] button') as HTMLButtonElement).click());
    expect(retries).toBe(1);
    await act(async () => retryRoot.unmount());
    host.remove();
  });
});
