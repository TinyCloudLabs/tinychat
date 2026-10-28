// TC-2199: the user's word fixes shown on every transcript surface of a note, and carried by Copy; stored text unchanged.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserRouter, MemoryRouter, useLocation, useNavigate } from "react-router-dom";

import { combineSpace, type CombineSpace, type SpaceRow } from "@/harness/fixtures/combineSpace";
import { _resetConnectorSchemaMemoForTests } from "@/lib/connectors/connectorStore";
import { initSizeClass } from "@/lib/sizeClass";
import { useLocalThreadStorage } from "@/lib/threadStore";
import { NO_WORD_FIXES, withWordFix, type WordFix } from "@/lib/wordFixes/wordFixes";
import { resetWordFixesForTest, saveWordFixes } from "@/lib/wordFixes/wordFixesStore";
import { PATHS, screenFor } from "@/shell/routes";
import { installDom } from "@/test/dom";
import type { LibraryItem } from "./LibraryRow";
import { NoteDetail } from "./NoteDetail";
import { NoteDetailView } from "./NoteDetailView";
import { useLibrary } from "./useLibrary";

const noop = () => {};
const LIST: readonly WordFix[] = [["tiny cloud", "TinyCloud"], ["eliza", "Eliza"]]
  .reduce<readonly WordFix[]>((list, [find, replace]) => withWordFix(list, { find: find!, replace: replace! }), NO_WORD_FIXES);
const timed = (rows: [string, number][]) => JSON.stringify(rows.map(([text, start], index) => ({ index, speaker_name: index % 2 ? "Ada" : "Grace", text, start_time: start, end_time: start + 5 })));
const STORED = timed([["We moved to tiny cloud last week.", 0], ["Ask ELIZA about Tiny   Cloud.", 6]]);
const MEETING: SpaceRow = { id: "row-a", source: "fireflies", sourceId: "p-a", title: "Weekly sync", startedAt: "2026-10-19T10:00:00.000Z", durationSecs: 360, participants: "[]", metadata: "{}", body: STORED };

let cleanup: (() => void) | undefined;
let root: Root | null = null;
let space: CombineSpace;
let copied: string[] = [];

beforeEach(() => {
  _resetConnectorSchemaMemoForTests();
  resetWordFixesForTest();
  cleanup = installDom();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
  const stop = initSizeClass(window);
  const before = cleanup;
  cleanup = () => { stop(); before(); };
  spyOn(console, "error").mockImplementation(() => {});
  copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanup?.();
  resetWordFixesForTest();
});

function Surface() {
  const location = useLocation();
  const navigate = useNavigate();
  const screen = screenFor(location.pathname);
  const library = useLibrary(space.tcw, { visible: true, noteId: screen.noteId });
  return <NoteDetail key={screen.noteId} library={library} tcw={space.tcw} pushed={false} onBack={() => navigate(PATHS.library)} transcription={undefined} />;
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    if (until()) return;
  }
  throw new Error("timed out");
}

describe("an open note", () => {
  test("shows and copies the fixed text while the stored text stays as it was", async () => {
    space = combineSpace([MEETING], { did: "did:test:word-fixes" });
    useLocalThreadStorage(space.tcw);
    await saveWordFixes(space.tcw, LIST);
    window.history.replaceState(null, "", "/chat/capture/library/row-a");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<BrowserRouter><Surface /></BrowserRouter>));
    await settle(() => document.querySelectorAll('[data-testid="transcript-segment"]').length === 2);
    const rows = [...document.querySelectorAll('[data-testid="transcript-segment"]')].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("We moved to TinyCloud last week.");
    expect(rows[1]).toContain("Ask Eliza about TinyCloud.");
    await act(async () => { (document.querySelector('[data-testid="note-copy"]') as HTMLElement).click(); });
    await settle(() => copied.length === 1);
    expect(copied[0]).toBe("Grace: We moved to TinyCloud last week.\nAda: Ask Eliza about TinyCloud.");
    const menuItem = (text: string) => [...document.querySelectorAll("button")].find((button) => button.textContent === text)!;
    await act(async () => { menuItem("Copy with timestamps").click(); });
    await settle(() => copied.length === 2);
    expect(copied[1]).toBe("[00:00] Grace: We moved to TinyCloud last week.\n[00:06] Ada: Ask Eliza about TinyCloud.");
    const blobs: Blob[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => { blobs.push(blob as Blob); return "blob:export"; };
    await act(async () => { menuItem("Export as Markdown").click(); });
    expect(await blobs[0]!.text()).toContain("[00:06] Ada: Ask Eliza about TinyCloud.");
    expect(await blobs[0]!.text()).not.toContain("tiny cloud");
    expect(space.rows.get("row-a")!.body).toBe(STORED);
  });
});

describe("a note's transcript without times, a pasted transcript, and the text saved on the row", () => {
  const view = (patch: Parameters<typeof NoteDetailView>[0] extends infer P ? Partial<P> : never) => renderToStaticMarkup(
    <MemoryRouter>
      <NoteDetailView item={{ id: "r", source: "exo-upload", sourceId: "u", title: "Interview", startedAt: "2026-10-01T11:00:00.000Z", durationSecs: 60 } as LibraryItem}
        listStatus="ready" metadata={{ status: "ok", metadata: {} }} transcript={{ status: "ok", sentences: [] }} audio={null}
        copyState="idle" onCopy={noop} onRetry={noop} pushed onBack={noop} {...patch} />
    </MemoryRouter>);

  test("untimed blocks show the fixed text", async () => {
    space = combineSpace([], { did: "did:test:word-fixes" });
    useLocalThreadStorage(space.tcw);
    await saveWordFixes(space.tcw, LIST);
    const sentences = [{ index: 0, speaker_name: "Ada", text: "I use tiny cloud.", start_time: 0, end_time: 0 }];
    const html = view({ transcript: { status: "ok", sentences } });
    expect(html).toContain("I use TinyCloud.");
    expect(html).not.toContain("tiny cloud");
    expect(sentences[0]!.text).toBe("I use tiny cloud.");
  });

  test("a pasted transcript shows the fixed text", async () => {
    space = combineSpace([], { did: "did:test:word-fixes" });
    useLocalThreadStorage(space.tcw);
    await saveWordFixes(space.tcw, LIST);
    const html = view({ item: { id: "r", source: "exo-upload", sourceId: "u", title: "Pasted", startedAt: null, durationSecs: null, metadata: { capture: "pasted" } } as unknown as LibraryItem,
      metadata: { status: "ok", metadata: { capture: "pasted", transcript_text: "eliza at tiny cloud" } } });
    expect(html).toContain("Eliza at TinyCloud");
  });
});
