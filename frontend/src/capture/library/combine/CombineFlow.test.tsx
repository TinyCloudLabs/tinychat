// TC-1152 S2c-1: the Combine flow through the component the app renders (App -> CaptureSurface ->
// LibraryScreen / NoteDetail -> NoteDetailView), over a stateful fake space (fake data only).
// Behaviour, not wording of the source: what is listed, what is written and when, what a tap does.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { EXO_MERGED_SOURCE, transcriptKvKey } from "@tinyboilerplate/core";

import { combineMeetings } from "@/lib/connectors/combinedMeetingStore";
import { _resetConnectorSchemaMemoForTests } from "@/lib/connectors/connectorStore";
import { initSizeClass } from "@/lib/sizeClass";
import { PATHS, screenFor } from "@/shell/routes";
import { combineSpace, type CombineSpace, type SpaceRow } from "@/harness/fixtures/combineSpace";
import { installDom } from "@/test/dom";

// Radix portals do not attach in this DOM (happy-dom), so the sheet's chrome (BottomSheet / Dialog) is swapped for an
// inline stand-in with the same props. Everything inside it, and every component around it, is the real one; the
// real sheet is exercised by the Chromium harness screens (frontend/src/harness/screens/combine.tsx).
mock.module("../../../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" aria-label="sheet" {...props.contentProps}><h2>{props.title}</h2><p>{props.description}</p>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { LibraryScreen } = await import("../LibraryScreen");
const { NoteDetail } = await import("../NoteDetail");
const { useLibrary } = await import("../useLibrary");
const { useCombineFlow } = await import("./useCombineFlow");
import { COMBINE_MAX_SEGMENTS_PER_MEMBER } from "./bodySegments";

let cleanup: (() => void) | undefined;
let root: Root | null = null;
let space: CombineSpace;

beforeEach(() => {
  _resetConnectorSchemaMemoForTests();
  cleanup = installDom();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
  const stop = initSizeClass(window);
  const before = cleanup;
  cleanup = () => { stop(); before(); };
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanup?.();
});

// Sentence i of a meeting is six tokens unique to (seed, i), so every 4-word run is a text anchor.
const sentence = (seed: string, i: number) => ["a", "b", "c", "d", "e", "f"].map((t) => `${seed}${i}${t}`).join(" ");
const body = (seed: string, from: number, to: number, speaker: (i: number) => string) => JSON.stringify(
  Array.from({ length: to - from }, (_, k) => ({ index: k, speaker_name: speaker(from + k), text: sentence(seed, from + k), start_time: k * 12, end_time: k * 12 + 11 })));

const FF: SpaceRow = { id: "row-a", source: "fireflies", sourceId: "p-a", title: "Weekly sync", startedAt: "2026-10-19T10:00:00.000Z", durationSecs: 360, participants: JSON.stringify([{ name: "Ada" }, { name: "Grace" }]), metadata: "{}", body: body("p", 0, 30, (i) => (i % 2 ? "Ada" : "Grace")) };
const NT: SpaceRow = { id: "row-b", source: "tinycloud-transcriber", sourceId: "p-b", title: "Weekly sync (notetaker)", startedAt: "2026-10-19T10:02:00.000Z", durationSecs: 360, participants: "[]", metadata: "{}", body: body("p", 10, 40, (i) => `speaker_${i % 2}`) };
// Same time window as the pair, different words: the check must refuse it.
const OTHER: SpaceRow = { id: "row-x", source: "google-meet", sourceId: "x-1", title: "Other call", startedAt: "2026-10-19T10:05:00.000Z", durationSecs: 360, participants: "[]", metadata: "{}", body: body("q", 0, 30, () => "Lee") };
const NEXT_DAY: SpaceRow = { id: "row-d", source: "fireflies", sourceId: "d-1", title: "Next day", startedAt: "2026-10-20T10:00:00.000Z", durationSecs: 360, metadata: "{}", body: body("p", 0, 30, () => "Ada") };
const VOICE: SpaceRow = { id: "row-v", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note", startedAt: "2026-10-19T10:01:00.000Z", durationSecs: 60, metadata: "{}" };
const NOTES: SpaceRow = { id: "row-g", source: "google-meet", sourceId: "drive-file", title: "Notes by Gemini", startedAt: "2026-10-19T10:00:00.000Z", durationSecs: null, metadata: JSON.stringify({ notes_kind: "gemini", notes_association: "standalone" }) };

const NOW = () => new Date("2026-10-20T09:00:00.000Z");
const mergedRows = () => [...space.rows.values()].filter((r) => r.source === EXO_MERGED_SOURCE);
const writes = () => space.log.filter((c) => c.write);
const originals = () => JSON.stringify([...space.rows.values()].filter((r) => r.source !== EXO_MERGED_SOURCE));
const originalKv = () => JSON.stringify([...space.kv].filter(([k]) => !k.includes(`/${EXO_MERGED_SOURCE}/`)));

/**
 * The Library list and the open note, wired the way CaptureSurface wires them (one useLibrary, then
 * LibraryScreen and NoteDetail), without the Capture home beside them: its recorder halo needs WebGL,
 * which this DOM does not have. CaptureSurface passing `tcw` to NoteDetail is checked by the type
 * checker and by the Chromium harness screens.
 */
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
      <NoteDetail key={screen.noteId} library={library} tcw={space.tcw} pushed={false} onBack={() => navigate(PATHS.library)} transcription={undefined} />
    </>
  );
}

async function settle(until: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    if (until()) return;
  }
  throw new Error(`timed out waiting for ${what}`);
}
const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const all = (testId: string) => [...document.querySelectorAll(`[data-testid="${testId}"]`)] as HTMLElement[];
const has = (testId: string) => q(testId) !== null;
const text = () => document.body.textContent ?? "";
const click = (testId: string) => act(async () => { q(testId)!.click(); });

async function open(rowId: string, rows: SpaceRow[], prepare?: (s: CombineSpace) => Promise<void>, waitForNote = true) {
  space = combineSpace(rows, { did: "did:test:combine-ui" });
  await prepare?.(space);
  window.history.replaceState(null, "", `/chat/capture/library/${rowId}`);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <BrowserRouter><Surface /></BrowserRouter>,
  ));
  if (waitForNote) await settle(() => q("note-detail")?.getAttribute("data-note-id") === rowId, `note ${rowId}`);
}

async function combineViaStore(rows: SpaceRow[] = [FF, NT]): Promise<string> {
  const s = combineSpace(rows);
  const res = await combineMeetings(s.tcw, { source: FF.source, sourceId: FF.sourceId }, { source: NT.source, sourceId: NT.sourceId }, { now: NOW });
  if (!res.ok || res.data.status !== "written") throw new Error("seed combine failed");
  // Hand the seeded state to the test's space.
  rowsToSeed = [...s.rows.values()];
  kvToSeed = new Map(s.kv);
  return res.data.id;
}
let rowsToSeed: SpaceRow[] = [];
let kvToSeed = new Map<string, string>();
const seedKv = async (s: CombineSpace) => { for (const [k, v] of kvToSeed) s.kv.set(k, v); };

describe("Combine entry and picker", () => {
  test("a meeting capture offers Combine; the picker lists only other overlapping meeting captures", async () => {
    await open("row-a", [FF, NT, OTHER, NEXT_DAY, VOICE, NOTES]);
    expect(has("combine-entry")).toBe(true);
    await click("combine-entry");
    await settle(() => has("combine-sheet"), "picker");
    const listed = all("combine-candidate").map((el) => el.getAttribute("data-item-id"));
    // Not itself, not the next day's, not a voice note, not a Gemini-notes row (it has no length).
    expect(listed.sort()).toEqual(["row-b", "row-x"]);
    expect(writes()).toEqual([]);
  });

  test("a voice note and a combined meeting do not offer Combine", async () => {
    await open("row-v", [FF, NT, VOICE]);
    expect(has("combine-entry")).toBe(false);
  });

  test("with no overlapping capture the picker says so", async () => {
    await open("row-a", [FF, NEXT_DAY]);
    await click("combine-entry");
    await settle(() => has("combine-no-candidates"), "empty picker");
  });
});

describe("Combine confirm and write", () => {
  test("a passing pair shows the evidence, writes nothing until Combine, then lists and opens the combined meeting", async () => {
    await open("row-a", [FF, NT]);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    await click("combine-candidate");
    await settle(() => has("combine-confirm"), "confirm sheet");

    expect(q("combine-confirm")!.getAttribute("data-passed")).toBe("true");
    expect(q("combine-verdict")!.textContent).toBe("These look like the same meeting");
    const lines = all("combine-evidence")[0]!.querySelectorAll("[data-evidence]");
    expect([...lines].map((l) => l.getAttribute("data-evidence"))).toEqual(["phrases", "spread", "offset", "overlap", "gap", "participants"]);
    expect(text()).toContain("per minute of the shorter capture");
    expect(text()).toContain("at least 1.25 per minute");
    expect(has("combine-anyway-button")).toBe(false);
    // Reading and stitching happened; no write, no combined row.
    expect(writes()).toEqual([]);
    expect(mergedRows()).toHaveLength(0);

    const before = originals() + originalKv();
    await click("combine-confirm-button");
    await settle(() => q("note-detail")?.getAttribute("data-note-id") === mergedRows()[0]?.id && mergedRows().length === 1, "combined meeting opened");
    expect(mergedRows()).toHaveLength(1);
    expect(JSON.parse(mergedRows()[0]!.metadata!).merge.detection.passed).toBe(true);
    // Originals untouched.
    expect(originals() + originalKv()).toBe(before);
    for (const w of writes()) expect(w.kind === "kv" ? w.text.includes("/exo-merged/") : w.text.includes("'exo-merged'") || w.text.startsWith("INSERT")).toBe(true);
    // Listed in the Library as a combined meeting, with both originals still listed.
    await settle(() => all("library-item").length === 3, "three rows listed");
    expect(all("library-item").map((r) => r.textContent).join("|")).toContain("Combined meeting");
    // The combined meeting's page names its members and never the raw source string.
    await settle(() => has("combined-members"), "members");
    expect(all("combined-member").map((m) => m.textContent).join("|")).toContain("Weekly sync");
    expect(q("how-this-got-here")!.textContent).toContain("Combined from Fireflies + Notetaker");
    expect(q("how-this-got-here")!.textContent).not.toContain("exo-merged");
    expect(has("combined-delete")).toBe(true);
  });

  test("cancelling at the confirm step writes nothing", async () => {
    await open("row-a", [FF, NT]);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    await click("combine-candidate");
    await settle(() => has("combine-confirm"), "confirm sheet");
    const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent === "Don’t combine")!;
    await act(async () => cancel.click());
    await settle(() => !has("combine-sheet"), "sheet closed");
    expect(writes()).toEqual([]);
    expect(mergedRows()).toHaveLength(0);
  });

  test("a failing pair says so with the phrase count, offers only Combine anyway, and records passed=false", async () => {
    await open("row-a", [FF, OTHER]);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    await click("combine-candidate");
    await settle(() => has("combine-confirm"), "confirm sheet");

    expect(q("combine-confirm")!.getAttribute("data-passed")).toBe("false");
    expect(q("combine-verdict")!.textContent).toMatch(/^These don.t look like the same meeting \(\d+ matching phrases?\)$/);
    expect(has("combine-confirm-button")).toBe(false);
    expect(has("combine-anyway-button")).toBe(true);
    expect(writes()).toEqual([]);

    await click("combine-anyway-button");
    await settle(() => mergedRows().length === 1, "forced write");
    expect(JSON.parse(mergedRows()[0]!.metadata!).merge.detection.passed).toBe(false);
  });
});

describe("Combine states", () => {
  test("a member above the size guard is refused with a plain message, before anything is stitched or written", async () => {
    const huge = JSON.stringify(Array.from({ length: COMBINE_MAX_SEGMENTS_PER_MEMBER + 1 }, (_, i) => ({ index: i, speaker_name: "A", text: `w${i} x${i} y${i} z${i}`, start_time: i, end_time: i + 0.5 })));
    await open("row-a", [FF, { ...NT, body: huge }]);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    await click("combine-candidate");
    await settle(() => has("combine-too-large"), "size guard");
    expect(text()).toContain("too long to combine here");
    expect(text()).toContain("10,001");
    expect(writes()).toEqual([]);
  });

  test("a read that fails shows an error with Try again, and nothing is written", async () => {
    await open("row-a", [FF, NT]);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    space.failNext.kv = "get";
    await click("combine-candidate");
    await settle(() => has("combine-error"), "error state");
    expect(has("combine-retry")).toBe(true);
    expect(writes()).toEqual([]);
    await click("combine-retry");
    await settle(() => has("combine-confirm"), "confirm after retry");
  });

  test("a write that fails shows an error and leaves no combined row", async () => {
    await open("row-a", [FF, NT]);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    await click("combine-candidate");
    await settle(() => has("combine-confirm"), "confirm sheet");
    space.failNext.sql = /^INSERT/;
    await click("combine-confirm-button");
    await settle(() => has("combine-error"), "write error");
    expect(mergedRows()).toHaveLength(0);
  });

  test("cancel while checking stops the check; nothing is written", async () => {
    await open("row-a", [FF, NT]);
    await click("combine-entry");
    await settle(() => has("combine-candidate"), "candidates");
    space.getDelayMs = 80;
    await click("combine-candidate");
    expect(has("combine-analyzing")).toBe(true);
    const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancel.click());
    await settle(() => !has("combine-sheet"), "sheet closed");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(has("combine-sheet")).toBe(false);
    expect(writes()).toEqual([]);
  });
});

describe("The combined meeting's page", () => {
  test("Delete combined meeting asks first, deletes only the combined meeting, and leaves exactly the originals", async () => {
    const id = await combineViaStore();
    await open(id, rowsToSeed, seedKv);
    const before = originals() + originalKv();
    await click("combined-delete");
    await settle(() => has("delete-combined-sheet"), "confirm dialog");
    expect(mergedRows()).toHaveLength(1);
    await click("delete-combined-confirm");
    await settle(() => mergedRows().length === 0, "deleted");
    expect(originals() + originalKv()).toBe(before);
    expect([...space.kv.keys()].filter((k) => k.includes("/exo-merged/"))).toEqual([]);
    await settle(() => all("library-item").length === 2, "list shows the originals only");
    expect(all("library-item").map((r) => r.textContent).join("|")).not.toContain("Combined meeting");
  });

  test("a row with garbage metadata is still listed, opens, and can be deleted", async () => {
    const garbage: SpaceRow = { id: "row-m", source: EXO_MERGED_SOURCE, sourceId: "merged-garbage", title: "Planning", startedAt: "2026-10-19T10:00:00.000Z", durationSecs: 600, participants: "not json", metadata: "{{{not json", body: "[]" };
    await open("row-m", [FF, NT, garbage]);
    expect(q("note-detail")!.getAttribute("data-note-id")).toBe("row-m");
    await settle(() => all("library-item").length === 3, "garbage row listed");
    expect(q("how-this-got-here")!.textContent).not.toContain("exo-merged");
    await click("combined-delete");
    await settle(() => has("delete-combined-sheet"), "confirm dialog");
    await click("delete-combined-confirm");
    await settle(() => !space.rows.has("row-m"), "garbage row deleted");
    expect(space.rows.has("row-a") && space.rows.has("row-b")).toBe(true);
  });

  test("opening it runs the read-time sweep: its members are read, and it stays when they are there", async () => {
    const id = await combineViaStore();
    await open(id, rowsToSeed, seedKv);
    await settle(() => space.log.some((c) => c.kind === "kv" && c.method === "get" && c.text.endsWith("/transcript/p-a")), "sweep read a member");
    expect(space.log.some((c) => c.kind === "kv" && c.text.endsWith("/transcript/p-b"))).toBe(true);
    expect(mergedRows()).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  test("a member that is gone makes the sweep delete the combined meeting and refresh the Library", async () => {
    const id = await combineViaStore();
    const gone = rowsToSeed.filter((r) => r.id !== "row-b");
    await open(id, gone, async (s) => { await seedKv(s); s.kv.delete(transcriptKvKey("tinycloud-transcriber", "p-b")); }, false);
    await settle(() => mergedRows().length === 0, "swept");
    await settle(() => has("note-absent"), "page shows it is gone");
  });

  test("a sweep read that fails keeps the combined meeting on screen and deletes nothing", async () => {
    const id = await combineViaStore();
    await open(id, rowsToSeed, async (s) => { await seedKv(s); s.failNext.kv = "get"; });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(mergedRows()).toHaveLength(1);
    expect(has("combined-delete")).toBe(true);
  });

  test("a member whose text changed shows 'a source changed' with Re-combine", async () => {
    const id = await combineViaStore();
    await open(id, rowsToSeed, async (s) => {
      await seedKv(s);
      s.kv.set(transcriptKvKey("fireflies", "p-a"), body("p", 0, 30, (i) => (i % 2 ? "Zed" : "Yuri")));
    });
    await settle(() => has("combined-stale"), "stale notice");
    expect(q("combined-stale")!.textContent).toContain("A source changed");
    expect(has("combined-recombine")).toBe(true);
  });
});

describe("Re-combine", () => {
  test("re-combining a drifted pair rewrites the open meeting in place, shows the new text and drops the stale notice", async () => {
    const id = await combineViaStore();
    await open(id, rowsToSeed, async (s) => {
      await seedKv(s);
      s.kv.set(transcriptKvKey("fireflies", "p-a"), body("p", 0, 30, (i) => (i % 2 ? "Zed" : "Yuri")));
    });
    await settle(() => has("combined-recombine"), "re-combine offered");
    expect(text()).not.toContain("Yuri");
    await click("combined-recombine");
    await settle(() => has("combine-confirm"), "confirm sheet");
    await click("combine-confirm-button");
    await settle(() => text().includes("Yuri"), "new transcript shown");
    await settle(() => !has("combined-stale"), "stale notice gone");
    expect(mergedRows()).toHaveLength(1);
    expect(mergedRows()[0]!.id).toBe(id);
  });
});

describe("useCombineFlow", () => {
  interface Seen { flow: ReturnType<typeof useCombineFlow> | null }
  function Probe(props: { tcw: CombineSpace["tcw"]; seen: Seen }) {
    props.seen.flow = useCombineFlow({ tcw: props.tcw, onCombined: () => {} });
    return null;
  }
  const item = (row: SpaceRow) => ({ id: row.id, source: row.source, sourceId: row.sourceId, title: row.title, startedAt: row.startedAt, durationSecs: row.durationSecs });
  async function mountProbe(rows: SpaceRow[]) {
    space = combineSpace(rows);
    const seen: Seen = { flow: null };
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Probe tcw={space.tcw} seen={seen} />));
    return seen;
  }

  test("confirm(false) on a pair the check refused writes nothing and stays on the confirm step", async () => {
    const seen = await mountProbe([FF, OTHER]);
    await act(async () => seen.flow!.open(item(FF), item(OTHER)));
    await settle(() => seen.flow!.state.step === "confirm", "confirm step");
    await act(async () => seen.flow!.confirm(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(seen.flow!.state.step).toBe("confirm");
    expect(writes()).toEqual([]);
  });

  test("a change of account cancels a check in progress and clears the flow; the old space is never written", async () => {
    const seen = await mountProbe([FF, NT]);
    const first = space;
    first.getDelayMs = 80;
    await act(async () => seen.flow!.open(item(FF), item(NT)));
    expect(seen.flow!.state.step).toBe("analyzing");
    const other = combineSpace([FF, NT], { did: "did:test:another-account" });
    await act(async () => root!.render(<Probe tcw={other.tcw} seen={seen} />));
    expect(seen.flow!.state.step).toBe("idle");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(seen.flow!.state.step).toBe("idle");
    expect(first.log.filter((c) => c.write)).toEqual([]);
    expect(other.log.filter((c) => c.write)).toEqual([]);
  });

  test("a write that throws ends in the error state with Try again, never stuck saving", async () => {
    const seen = await mountProbe([FF, NT]);
    await act(async () => seen.flow!.open(item(FF), item(NT)));
    await settle(() => seen.flow!.state.step === "confirm", "confirm step");
    space.tcw.kv.put = (async () => { throw new Error("boom"); }) as never;
    await act(async () => seen.flow!.confirm(false));
    await settle(() => seen.flow!.state.step === "error", "error state");
    expect(mergedRows()).toHaveLength(0);
  });
});
