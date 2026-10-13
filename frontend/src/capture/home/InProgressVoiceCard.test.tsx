import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { NotePipeline, PipelineActionKind } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { installDom } from "@/test/dom";
import { InProgressVoiceCard, type InProgressNoteRow } from "./InProgressVoiceCard";

const pipeline = (patch: Partial<NotePipeline> = {}): NotePipeline => ({
  steps: [
    { key: "phone", label: "On this phone", state: "done" },
    { key: "space", label: "In your space", state: "active", caption: "Uploading audio to your TinyCloud space · 42%", progress: 0.42 },
    { key: "transcript", label: "Transcript", state: "upcoming" },
    { key: "notes", label: "Notes", state: "skipped" },
  ],
  current: "space",
  done: false,
  ...patch,
});
const row = (id: string, value = pipeline()): InProgressNoteRow => ({ id, title: `Note ${id}`, duration: "1:05", spokenDuration: "1 min", pipeline: value });
const html = (rows: readonly InProgressNoteRow[], patch: Partial<Parameters<typeof InProgressVoiceCard>[0]> = {}) => renderToStaticMarkup(
  <InProgressVoiceCard rows={rows} onOpen={() => {}} onAction={() => {}} onOpenLibrary={() => {}} {...patch} />,
);

let cleanupDom: (() => void) | undefined;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanupDom?.();
  cleanupDom = undefined;
});

describe("InProgressVoiceCard", () => {
  test("shows the unfinished count, upload summary, compact rows and Halo", () => {
    const waiting = pipeline({ steps: [
      { key: "phone", label: "On this phone", state: "done" },
      { key: "space", label: "In your space", state: "waiting", caption: "Waiting to upload" },
      { key: "transcript", label: "Transcript", state: "upcoming" },
      { key: "notes", label: "Notes", state: "skipped" },
    ] });
    const output = html([row("a"), row("b", waiting)]);
    expect(output).toContain('data-testid="voice-note-summary">2 in progress</b>');
    expect(output).toContain('data-testid="voice-note-on-phone">2 on this phone</span>');
    expect(output).toContain('data-testid="voice-note-uploading">1 uploading</span>');
    expect(output).toContain("Uploading audio to your TinyCloud space · 42%");
    expect(output).toContain("Waiting to upload");
    expect(output.match(/data-pipeline-track-summary=/g)).toHaveLength(2);
  });

  test("the summary counts what is in progress; only notes not yet in the space are on this phone, and none means no subline", () => {
    const inSpace = pipeline({
      steps: [
        { key: "phone", label: "On this phone", state: "done" },
        { key: "space", label: "In your space", state: "done" },
        { key: "transcript", label: "Transcript", state: "active", caption: "Transcribing…" },
        { key: "notes", label: "Notes", state: "skipped" },
      ],
      current: "transcript",
    });
    const mixed = html([row("a"), row("b", inSpace), row("c", inSpace)]);
    expect(mixed).toContain('data-testid="voice-note-summary">3 in progress</b>');
    expect(mixed).toContain('data-testid="voice-note-on-phone">1 on this phone</span>');
    const allInSpace = html([row("b", inSpace), row("c", inSpace)]);
    expect(allInSpace).toContain('data-testid="voice-note-summary">2 in progress</b>');
    expect(allInSpace).not.toContain("voice-note-on-phone");
    expect(allInSpace).not.toContain("on this phone</");
  });

  test("selects the highest priority action and keeps offline automatic", () => {
    const signedOut = pipeline({ current: "space", blocker: { cause: "You're signed out. This note is safe on this phone.", action: { kind: "sign-in", label: "Sign in" } } });
    const failed = pipeline({ current: "space", blocker: { cause: "Saving timed out.", action: { kind: "retry", label: "Try again" } } });
    const output = html([row("failed", failed), row("signed-out", signedOut)]);
    expect(output).toContain(">Sign in<");
    expect(output).not.toContain(">Try again<");
    expect(html([row("failed", failed)])).toContain(">Try again<");
    const offline = pipeline({ steps: [
      { key: "phone", label: "On this phone", state: "done" },
      { key: "space", label: "In your space", state: "waiting", caption: "Waiting for a connection · Exo continues automatically" },
      { key: "transcript", label: "Transcript", state: "upcoming" },
      { key: "notes", label: "Notes", state: "skipped" },
    ] });
    const offlineHtml = html([row("offline", offline)]);
    expect(offlineHtml).toContain("Waiting for a connection. Exo continues automatically.");
    expect(offlineHtml).not.toContain("soft-pill");
  });

  test("shows model bytes and the more link, and disappears when done", () => {
    const waitingForModel = pipeline({ steps: [
      { key: "phone", label: "On this phone", state: "done" },
      { key: "space", label: "In your space", state: "done" },
      { key: "transcript", label: "Transcript", state: "active", caption: "Waiting for the on-device model · 42%" },
      { key: "notes", label: "Notes", state: "skipped" },
    ], current: "transcript" });
    const rows = [row("1", waitingForModel), row("2"), row("3"), row("4")];
    const output = html(rows, { model: { bytes: 268_000_000, totalBytes: 640_000_000 } });
    expect(output).toContain("On-device model");
    expect(output).toContain("268 of 640 MB");
    expect(output).toContain("+1 more");
    expect(output.match(/class="soft-progress-row"/g)).toHaveLength(3);
    expect(html([row("done", pipeline({ done: true, current: null }))])).toBe("");
  });

  test("announces each track, followed by the spoken duration", () => {
    const output = html([row("a", { ...pipeline(), current: "space" })]);
    expect(output).toContain('aria-label="Note a. Audio on this phone: Saved. Audio in your space: Uploading audio to your TinyCloud space · 42%. Transcript: Not started. 1 min"');
  });

  test("shows audio and transcript independently in each in-progress row", () => {
    const transcriptSaved = pipeline({ steps: [
      { key: "phone", label: "Audio on this phone", state: "done" },
      { key: "space", label: "Audio in your space", state: "active", caption: "Uploading audio to your TinyCloud space · 42%" },
      { key: "transcript", label: "Transcript", state: "done", sublabel: "Ready on this phone" },
      { key: "notes", label: "Notes", state: "skipped" },
    ] });
    const output = html([row("ahead", transcriptSaved)]);
    expect(output).toContain("Audio: Uploading audio to your TinyCloud space · 42%");
    expect(output).toContain("Transcript: Ready on this phone");
  });

  test("a blocker pill tap calls the action handler with its kind and source id", async () => {
    cleanupDom = installDom();
    const container = document.createElement("div");
    document.body.append(container);
    const seen: string[][] = [];
    const blocked = pipeline({
      blocker: { cause: "You're signed out. This note is safe on this phone.", action: { kind: "sign-in", label: "Sign in" } },
    });
    const views = new Map<string, NotePipelineView>([["rec-a", {
      pipeline: blocked,
      onAction: (kind: PipelineActionKind) => seen.push([kind, "rec-a"]),
      actionError: null,
    }]]);
    root = createRoot(container);
    await act(async () => root!.render(
      <InProgressVoiceCard
        rows={[{ ...row("row-a", blocked), pipelineId: "rec-a" }]}
        onOpen={() => {}}
        onAction={(kind, id) => views.get(id)?.onAction(kind)}
        onOpenLibrary={() => {}}
      />,
    ));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="voice-note-action"]')!.click());
    expect(seen).toEqual([["sign-in", "rec-a"]]);
  });
});
