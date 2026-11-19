// TC-1152 v1b-b: a combined meeting's summary through the components the app renders (LibraryScreen /
// NoteDetail -> NoteDetailView -> CombinedSummary), over a stateful fake space and a fake model call
// (synthetic data only; no network). Behaviour: what the page shows, what is called, what is written.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { EXO_MERGED_SOURCE, transcriptKvKey } from "@tinyboilerplate/core";

import { combineMeetings } from "@/lib/connectors/combinedMeetingStore";
import { _resetConnectorSchemaMemoForTests } from "@/lib/connectors/connectorStore";
import type { CallFailure } from "@/lib/meetingSummary/generateSummary";
import { createSummaryRunner, type SummaryRunner } from "@/lib/meetingSummary/summaryRunner";
import { scheduledSpace } from "@/lib/spaceQueue";
import { initSizeClass } from "@/lib/sizeClass";
import { PATHS, screenFor } from "@/shell/routes";
import { combineSpace, type CombineSpace, type SpaceRow } from "@/harness/fixtures/combineSpace";
import { installDom } from "@/test/dom";
import { writeAutomaticSummaries } from "@/lib/meetingSummary/automaticSummaries";
import { useLocalThreadStorage } from "@/lib/threadStore";

// Radix portals do not attach in this DOM, so the sheet chrome is an inline stand-in (as in CombineFlow.test.tsx).
mock.module("../../../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" aria-label="sheet" {...props.contentProps}><h2>{props.title}</h2><p>{props.description}</p>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { LibraryScreen } = await import("../LibraryScreen");
const { NoteDetail } = await import("../NoteDetail");
const { useLibrary } = await import("../useLibrary");

let cleanup: (() => void) | undefined;
let root: Root | null = null;
let space: CombineSpace;
let runner: SummaryRunner;
let modelCalls: string[][];
let reply: (call: number) => string | Error | Promise<string>;

const GOOD = "OVERVIEW:\nThe team agreed to ship the beta on Monday.\nACTION ITEMS:\n- Ana: freeze the build\n- Ben: write the notes";
const classify = (error: unknown): CallFailure => (error instanceof Error ? (error.message as CallFailure) : "other");

beforeEach(() => {
  _resetConnectorSchemaMemoForTests();
  cleanup = installDom();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
  const stop = initSizeClass(window);
  const before = cleanup;
  cleanup = () => { stop(); before(); };
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
  modelCalls = [];
  reply = () => GOOD;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  runner?.cancelAll();
  cleanup?.();
});

const sentence = (seed: string, i: number) => ["a", "b", "c", "d", "e", "f"].map((t) => `${seed}${i}${t}`).join(" ");
const body = (seed: string, from: number, to: number, speaker: (i: number) => string) => JSON.stringify(
  Array.from({ length: to - from }, (_, k) => ({ index: k, speaker_name: speaker(from + k), text: sentence(seed, from + k), start_time: k * 12, end_time: k * 12 + 11 })));
const FF: SpaceRow = { id: "row-a", source: "fireflies", sourceId: "p-a", title: "Weekly sync", startedAt: "2026-10-19T10:00:00.000Z", durationSecs: 360, participants: JSON.stringify([{ name: "Ada" }, { name: "Grace" }]), metadata: "{}", body: body("p", 0, 30, (i) => (i % 2 ? "Ada" : "Grace")) };
const NT: SpaceRow = { id: "row-b", source: "tinycloud-transcriber", sourceId: "p-b", title: "Weekly sync (notetaker)", startedAt: "2026-10-19T10:02:00.000Z", durationSecs: 360, participants: "[]", metadata: "{}", body: body("p", 10, 40, (i) => `speaker_${i % 2}`) };
const NOW = () => new Date("2026-10-20T09:00:00.000Z");
const mergedRow = () => [...space.rows.values()].find((r) => r.source === EXO_MERGED_SOURCE);
const writes = () => space.log.filter((c) => c.write);
const summaryWrites = () => writes().filter((c) => c.text.startsWith("UPDATE connector_meeting SET summary_overview"));

function Surface() {
  const location = useLocation();
  const navigate = useNavigate();
  const screen = screenFor(location.pathname);
  const library = useLibrary(space.tcw, { visible: true, noteId: screen.noteId });
  return (
    <>
      <div data-testid="capture-library">
        <LibraryScreen library={library} pushed={false} onBack={() => navigate(PATHS.capture)} selectedId={screen.noteId} now={NOW()} column="" />
      </div>
      <NoteDetail key={screen.noteId} library={library} tcw={space.tcw} pushed={false} onBack={() => navigate(PATHS.library)} transcription={undefined} summaries={runner} />
    </>
  );
}

async function settle(until: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    if (until()) return;
  }
  throw new Error(`timed out waiting for ${what}`);
}
const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const has = (testId: string) => q(testId) !== null;
const text = () => document.body.textContent ?? "";
const click = (testId: string) => act(async () => { q(testId)!.click(); });
const summaryState = () => q("combined-summary")?.getAttribute("data-state") ?? null;

async function open(rowId: string, rows: SpaceRow[], seed?: (s: CombineSpace) => void) {
  space = combineSpace(rows, { did: "did:test:combined-summary" });
  useLocalThreadStorage(space.tcw);
  seed?.(space);
  runner = createSummaryRunner({
    space: scheduledSpace(space.tcw),
    classify,
    complete: async (messages) => {
      modelCalls.push(messages.map((m) => m.content));
      const out = await reply(modelCalls.length);
      if (out instanceof Error) throw out;
      return out;
    },
  });
  window.history.replaceState(null, "", `/chat/capture/library/${rowId}`);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><Surface /></BrowserRouter>));
  await settle(() => q("note-detail")?.getAttribute("data-note-id") === rowId, `note ${rowId}`);
}

/** A combined row (made by the real store) with its originals, seeded into a fresh space; returns its id. */
async function seededCombined(): Promise<{ id: string; rows: SpaceRow[]; kv: Map<string, string> }> {
  const s = combineSpace([FF, NT]);
  const res = await combineMeetings(s.tcw, { source: FF.source, sourceId: FF.sourceId }, { source: NT.source, sourceId: NT.sourceId }, { now: NOW });
  if (!res.ok || res.data.status !== "written") throw new Error("seed combine failed");
  return { id: res.data.id, rows: [...s.rows.values()], kv: new Map(s.kv) };
}
const seedKv = (kv: Map<string, string>) => (s: CombineSpace) => { for (const [k, v] of kv) s.kv.set(k, v); };

async function combineThroughTheFlow() {
  await open("row-a", [FF, NT]);
  await click("combine-entry");
  await settle(() => has("combine-candidate"), "candidates");
  await click("combine-candidate");
  await settle(() => has("combine-confirm"), "confirm sheet");
  await click("combine-confirm-button");
}

describe("after a combine", () => {
  test("the page shows 'Generating summary…', then the summary; one model call from the combined text; one two-column write", async () => {
    let release!: () => void;
    reply = () => new Promise<string>((resolve) => { release = () => resolve(GOOD); });
    await combineThroughTheFlow();
    await settle(() => mergedRow() !== undefined && q("note-detail")?.getAttribute("data-note-id") === mergedRow()!.id, "combined page");
    await settle(() => summaryState() === "generating", "generating state");
    expect(text()).toContain("Generating summary…");
    expect(has("combined-summary-retry")).toBe(false);
    release();
    await settle(() => summaryState() === "ready", "summary shown");
    expect(text()).toContain("The team agreed to ship the beta on Monday.");
    expect(q("combined-summary-actions")!.textContent).toContain("Ana: freeze the build");
    expect(modelCalls).toHaveLength(1);
    // The model was given the combined text (both sources' sentences), once.
    expect(modelCalls[0]![1]).toContain("p0a");
    expect(modelCalls[0]![1]).toContain("p39a");
    expect(summaryWrites()).toHaveLength(1);
    expect(mergedRow()!.summaryOverview).toBe("The team agreed to ship the beta on Monday.");
    // The combine is complete and its metadata was written once, before the summary, never after.
    const metaWrites = writes().filter((c) => c.text.includes("metadata"));
    expect(metaWrites.every((c) => writes().indexOf(c) < writes().indexOf(summaryWrites()[0]!))).toBe(true);
  });

  test("a failed summary never fails the combine: the meeting is there, the page says 'Summary unavailable · Retry', and Retry regenerates", async () => {
    reply = () => new Error("boom");
    await combineThroughTheFlow();
    await settle(() => summaryState() === "unavailable", "unavailable state");
    expect(mergedRow()).toBeDefined();
    expect(text()).toContain("Summary unavailable");
    expect(has("combine-error")).toBe(false);
    expect(has("note-transcript")).toBe(true);
    expect(summaryWrites()).toEqual([]);
    expect(mergedRow()!.summaryOverview ?? null).toBeNull();
    reply = () => GOOD;
    await click("combined-summary-retry");
    await settle(() => summaryState() === "ready", "summary after Retry");
    expect(modelCalls).toHaveLength(2);
    expect(mergedRow()!.summaryOverview).toBe("The team agreed to ship the beta on Monday.");
  });

  test("out of credits: unavailable with the credits note, one call, nothing written", async () => {
    reply = () => new Error("paywall");
    await combineThroughTheFlow();
    await settle(() => summaryState() === "unavailable", "unavailable state");
    expect(q("combined-summary-unavailable")!.getAttribute("data-reason")).toBe("paywall");
    expect(text()).toContain("out of them");
    expect(modelCalls).toHaveLength(1);
    expect(summaryWrites()).toEqual([]);
  });
});

describe("opening a combined meeting", () => {
  test("with a stored summary shows it and makes no model call, however often it is opened", async () => {
    const seeded = await seededCombined();
    const rows = seeded.rows.map((r) => (r.id === seeded.id ? { ...r, summaryOverview: "Stored overview.", summaryActionItems: "First\nSecond" } : r));
    await open(seeded.id, rows, seedKv(seeded.kv));
    await settle(() => summaryState() === "ready", "stored summary");
    expect(text()).toContain("Stored overview.");
    expect(q("combined-summary-actions")!.querySelectorAll("li")).toHaveLength(2);
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    await open(seeded.id, rows, seedKv(seeded.kv));
    await settle(() => summaryState() === "ready", "stored summary again");
    expect(modelCalls).toHaveLength(0);
    expect(writes()).toEqual([]);
  });

  test("with no stored summary (older combine, or a combine with automatic summaries off) shows Generate and calls nothing until Generate is tapped", async () => {
    const seeded = await seededCombined();
    await open(seeded.id, seeded.rows, seedKv(seeded.kv));
    await settle(() => summaryState() === "idle", "idle state");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(modelCalls).toHaveLength(0);
    expect(has("combined-summary-retry")).toBe(false);
    expect(has("combined-summary-generate")).toBe(true);
    await click("combined-summary-generate");
    await settle(() => summaryState() === "ready", "summary after Generate");
    expect(modelCalls).toHaveLength(1);
  });

  test("a failed Retry-able run still shows Retry with the failed reason (not Generate)", async () => {
    reply = () => new Error("boom");
    await combineThroughTheFlow();
    await settle(() => summaryState() === "unavailable", "unavailable state");
    expect(has("combined-summary-retry")).toBe(true);
    expect(has("combined-summary-generate")).toBe(false);
  });

  test("a stored summary is shown as plain text: markup in it is never rendered", async () => {
    const seeded = await seededCombined();
    const rows = seeded.rows.map((r) => (r.id === seeded.id ? { ...r, summaryOverview: "Look <img src=x onerror=alert(1)> and <b>bold</b>", summaryActionItems: "<script>alert(1)</script>\n[link](javascript:alert(1))" } : r));
    await open(seeded.id, rows, seedKv(seeded.kv));
    await settle(() => summaryState() === "ready", "stored summary");
    const section = q("combined-summary")!;
    expect(section.querySelector("img, script, b, a")).toBeNull();
    expect(section.textContent).not.toMatch(/[<>]/);
  });
});

describe("Re-combine", () => {
  test("regenerates and overwrites the summary of the same meeting", async () => {
    const seeded = await seededCombined();
    const rows = seeded.rows.map((r) => (r.id === seeded.id ? { ...r, summaryOverview: "Old overview.", summaryActionItems: "Old item" } : r));
    await open(seeded.id, rows, (s) => {
      seedKv(seeded.kv)(s);
      s.kv.set(transcriptKvKey("fireflies", "p-a"), body("p", 0, 30, (i) => (i % 2 ? "Zed" : "Yuri")));
    });
    await settle(() => summaryState() === "ready", "old summary");
    expect(text()).toContain("Old overview.");
    reply = () => "OVERVIEW:\nA new overview of the new text.\nACTION ITEMS:\n- None";
    await settle(() => has("combined-recombine"), "re-combine offered");
    await click("combined-recombine");
    await settle(() => has("combine-confirm"), "confirm sheet");
    await click("combine-confirm-button");
    await settle(() => text().includes("A new overview of the new text."), "new summary shown");
    expect(text()).not.toContain("Old overview.");
    expect(modelCalls).toHaveLength(1);
    expect(mergedRow()!.summaryOverview).toBe("A new overview of the new text.");
    expect(mergedRow()!.id).toBe(seeded.id);
  });
});

describe("automatic summaries off", () => {
  test("a combine saves the meeting with no model call and no summary; Generate makes exactly one run", async () => {
    await open("row-a", [FF, NT]);
    await writeAutomaticSummaries(space.tcw, false);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    await click("combine-candidate");
    await settle(() => has("combine-confirm"), "confirm sheet");
    await click("combine-confirm-button");
    await settle(() => mergedRow() !== undefined && q("note-detail")?.getAttribute("data-note-id") === mergedRow()!.id, "combined page");
    await settle(() => summaryState() === "idle", "idle state");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(modelCalls).toHaveLength(0);
    expect(summaryWrites()).toEqual([]);
    expect(mergedRow()!.summaryOverview ?? null).toBeNull();
    await click("combined-summary-generate");
    await settle(() => summaryState() === "ready", "summary after Generate");
    expect(modelCalls).toHaveLength(1);
    expect(mergedRow()!.summaryOverview).toBe("The team agreed to ship the beta on Monday.");
  });
});
