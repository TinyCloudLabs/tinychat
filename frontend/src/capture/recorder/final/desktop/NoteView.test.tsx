import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRecorderProvider, type RecorderValue } from "../../RecorderProvider";
import { NoteView, type NoteViewProps } from "./NoteView";

const noop = () => {};
const recording: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  elapsedMs: 42_000,
  audioMs: 42_000,
  startedAt: 0,
  sheetOpen: true,
  noteStatus: "ready",
};

const props = (over: Partial<NoteViewProps> = {}): NoteViewProps => ({
  layout: "desktop",
  md: "Ask Dana",
  onChange: noop,
  view: "write",
  onViewChange: noop,
  noteStatus: "ready",
  pending: false,
  saveFailed: false,
  onExpand: noop,
  onMinimise: noop,
  onDone: noop,
  ...over,
});

const html = (over: Partial<NoteViewProps> = {}, value: Partial<RecorderValue> = recording) =>
  renderToStaticMarkup(
    <StaticRecorderProvider value={value}>
      <NoteView {...props(over)} />
    </StaticRecorderProvider>,
  );

describe("NoteView", () => {
  test("Write and Preview tabs show which is open; Done, Expand and Minimise are there", () => {
    const out = html();
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain(">Write<");
    expect(out).toContain(">Preview<");
    expect(out).toContain("Done");
    expect(out).toContain(">Expand<");
    expect(out).toContain('aria-label="Minimise recorder"');
    expect(out).toContain('data-layout="desktop"');
  });

  test("the recorder stays under the note: timer and a pause control", () => {
    const out = html();
    expect(out).toContain('role="timer"');
    expect(out).toContain("0:42");
    expect(out).toContain("Pause recording");
  });

  test("a paused recording offers Resume", () => {
    const out = html({}, { ...recording, mic: { state: "paused", reason: "user" } });
    expect(out).toContain("Resume recording");
  });

  test("Preview shows the rendered note instead of the field", () => {
    const out = html({ view: "preview" });
    expect(out).not.toContain("<textarea");
    expect(out).toContain("pr-nprev");
  });

  test("a note still loading shows a wait line and mounts no field, so it cannot save over the loaded note", () => {
    const out = html({ noteStatus: "loading" }, { ...recording, noteStatus: "loading" });
    expect(out).toContain("pr-nwait");
    expect(out).not.toContain("<textarea");
    expect(out).toContain('data-shown="true"');
  });

  test("a note that failed to load and a save that failed are alerts", () => {
    expect(html({ noteStatus: "error" })).toContain('role="alert"');
    const failed = html({ saveFailed: true });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('data-shown="false"');
  });

  test("the saved cue hides while a write is pending", () => {
    expect(html({ pending: true })).toContain('data-shown="false"');
    expect(html({ pending: false })).toContain('data-shown="true"');
  });
});
