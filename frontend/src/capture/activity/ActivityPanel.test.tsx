import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { installDom } from "@/test/dom";
import { ActivityNoteSection } from "./ActivityPanel";
import { activityForNote } from "./activitySelector";

let restore: (() => void) | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;
beforeEach(() => { restore = installDom(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); restore?.(); });

const items: LibraryItem[] = ["a", "b"].map((id) => ({ id, source: "exo-voice-note", sourceId: id, title: `Note ${id}`, startedAt: "2026-10-13T11:00:00Z", durationSecs: 60 }));
const openNote = () => {};
const close = () => {};
function view(percent: number): NotePipelineView {
  const input: NotePipelineInput = { device: "mac", route: "on-device", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null }, space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "running", error: null }, queue: { position: 0, inLine: 0, percent }, model: null, download: "idle", sync: null } },
    notes: { state: "idle" } };
  return { input, pipeline: notePipeline(input), provider: "local", onAction: () => {}, actionError: null };
}

test("one progress tick renders only its note row", async () => {
  const seen: { id: string; duration: number }[] = [];
  const rendered: string[] = [];
  const onRendered = (id: string) => { rendered.push(id); };
  const onRowRender = (id: string, _phase: "mount" | "update" | "nested-update", duration: number) => { seen.push({ id, duration }); };
  const b = view(20);
  const render = (a: NotePipelineView) => <>
    <Profiler id="a" onRender={onRowRender}><ActivityNoteSection item={items[0]!} jobs={activityForNote(a, "tauri")} onOpenNote={openNote} onClose={close} onRendered={onRendered} /></Profiler>
    <Profiler id="b" onRender={onRowRender}><ActivityNoteSection item={items[1]!} jobs={activityForNote(b, "tauri")} onOpenNote={openNote} onClose={close} onRendered={onRendered} /></Profiler>
  </>;
  await act(async () => root!.render(render(view(40))));
  expect(document.querySelectorAll("[data-activity-note]")).toHaveLength(2);
  seen.length = 0;
  rendered.length = 0;
  await act(async () => root!.render(render(view(41))));
  expect(rendered).toEqual(["a"]);
  expect(seen.some(({ id, duration }) => id === "a" && duration > 0)).toBe(true);
});
