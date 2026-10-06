// TC-522 part 2 — the chat screen's one-tap voice note.
//
// `QuickVoiceNoteView` is a pure function of its props, so its rules are asserted against real
// markup via react-dom/server:
//   1. the tap starts recording at once: the bar opens on "Starting the microphone…", with Stop
//      shown but not yet usable;
//   2. recording shows the elapsed time, the OS mic-state copy (silenced / no signal read as
//      warnings) and Stop; nothing closes the bar while it records or saves;
//   3. a saved note says so and links to Library; a failed save keeps the note on the phone and
//      says so;
//   4. outside the native app nothing renders.
// The controller is the Voice notes card's own (VoiceNotesSection), and App's wiring is pinned
// against the source, like connectorsNav.test.tsx: App pulls in @tinycloud/web-sdk, which a bun
// test process cannot evaluate.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { QuickVoiceNote, QuickVoiceNoteView, type QuickVoiceNoteViewProps } from "./QuickVoiceNote";

const noop = () => {};
const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

function render(patch: Partial<QuickVoiceNoteViewProps> = {}): string {
  return renderToStaticMarkup(
    <QuickVoiceNoteView
      phase="recording"
      mic={{ state: "recording", reason: null }}
      elapsedMs={12_000}
      level={0.4}
      error={null}
      pendingCount={0}
      saved={false}
      onStop={noop}
      onRecord={noop}
      onClose={noop}
      onOpenLibrary={noop}
      {...patch}
    />,
  );
}

describe("QuickVoiceNoteView", () => {
  test("starting: says so, with Stop shown but not usable yet", () => {
    const html = render({ phase: "starting", elapsedMs: 0 });
    expect(html).toContain("Starting the microphone…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="quick-voice-note-stop"/);
    expect(html).not.toContain('data-testid="quick-voice-note-close"');
  });

  test("recording: elapsed time, the level meter and Stop; no way to close it mid-recording", () => {
    const html = render();
    expect(html).toContain('aria-label="Voice note"');
    expect(html).toContain("Recording 0:12");
    expect(html).toContain('data-mic-state="recording"');
    expect(html).toContain('data-testid="quick-voice-note-stop"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("width:40%");
    expect(html).not.toContain('data-testid="quick-voice-note-close"');
    expect(html).not.toContain('data-testid="quick-voice-note-record"');
  });

  test("what the OS reports is told as a warning, with the card's words", () => {
    const silenced = render({ mic: { state: "silenced", reason: "os_silenced" } });
    expect(silenced).toContain("the system is blocking the microphone");
    expect(silenced).toContain('data-mic-state="silenced"');
    expect(silenced).toContain("text-amber-600");
    const noSignal = render({ mic: { state: "recording", reason: "no_signal" } });
    expect(noSignal).toContain("no sound is reaching the microphone");
    expect(noSignal).toContain('data-mic-reason="no_signal"');
  });

  test("saving: says where it goes, and offers neither Stop nor Close", () => {
    const html = render({ phase: "saving" });
    expect(html).toContain("Saving to your TinyCloud space…");
    expect(html).not.toContain('data-testid="quick-voice-note-stop"');
    expect(html).not.toContain('data-testid="quick-voice-note-close"');
  });

  test("saved: says so and links to Library, with Record again and Close", () => {
    const html = render({ phase: "idle", saved: true, elapsedMs: 0, level: 0 });
    expect(html).toContain("Saved to your TinyCloud space.");
    expect(html).toContain('data-testid="quick-voice-note-library"');
    expect(html).toContain("Open Library");
    expect(html).toContain('data-testid="quick-voice-note-record"');
    expect(html).toContain('aria-label="Close voice note"');
    expect(html).not.toContain("Recording");
  });

  test("a failed save is told, and the note left on the phone is counted", () => {
    const html = render({
      phase: "idle",
      error: "Recorded, but saving to your space failed: Failed to fetch",
      pendingCount: 1,
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Recorded, but saving to your space failed: Failed to fetch");
    expect(html).toContain("1 note is on this phone but not yet in your TinyCloud");
    expect(html).not.toContain("Saved to your TinyCloud space.");
    expect(html).not.toContain("Open Library");
  });

  test("a start that failed (e.g. no mic permission) can be retried or closed", () => {
    const html = render({ phase: "idle", error: "Microphone permission denied", elapsedMs: 0 });
    expect(html).toContain("Not recording. The microphone is off.");
    expect(html).toContain("Microphone permission denied");
    expect(html).toContain('data-testid="quick-voice-note-record"');
    expect(html).toContain('data-testid="quick-voice-note-close"');
  });
});

describe("QuickVoiceNote", () => {
  test("renders nothing outside the Exo mobile app", () => {
    expect(
      renderToStaticMarkup(
        <QuickVoiceNote
          tcw={{} as TinyCloudWeb}
          backendUrl="http://localhost"
          sessionStore={{} as SessionStore}
          onClose={noop}
          onOpenLibrary={noop}
        />,
      ),
    ).toBe("");
  });

  test("is the Voice notes card's controller, started at once, with a compact view", () => {
    const quick = read("QuickVoiceNote.tsx");
    expect(quick).toContain("<VoiceNotesSection");
    expect(quick).toContain("autoStart");
    expect(quick).toContain("render={(view) =>");
    // No recorder of its own: the plugin is only ever driven by the card's controller.
    expect(quick).not.toContain("VoiceNotes.start");
    expect(quick).not.toContain("VoiceNotes.stop");
  });

  test("the controller starts only when nothing is recording, and reports only a confirmed save", () => {
    const section = read("VoiceNotesSection.tsx");
    const auto = section.slice(section.indexOf("const autoStarted = useRef(false);"), section.indexOf("const transcription = transcriptionProps"));
    expect(auto).toContain("if (!autoStart || autoStarted.current) return;");
    expect(auto).toContain('.then((status) => status.state === "idle", () => true)');
    expect(auto).toContain("if (idle && mounted.current) void onRecord();");
    // onSaved fires once, right where the save is confirmed (after the list refresh and the
    // transcription hand-off), never on the path that keeps the note on the phone.
    expect(section.split("onSaved?.(").length - 1).toBe(1);
    expect(section).toMatch(/transcriber\?\.noteSaved\(recording, outcome\.audio \?\? undefined\);\s*onSaved\?\.\(recording\);/);
  });
});

describe("App wiring of the one-tap voice note", () => {
  const app = read("../App.tsx");

  test("offered only in the native app, signed in, on Chat only (never next to the Voice notes card)", () => {
    expect(app).toContain("const voiceNotesInApp = useMemo(() => nativeVoiceNotesAvailable(), []);");
    expect(app).toContain(
      'voiceNotesInApp && isReady && !LOCAL_VALIDATION && screen.destination === "chat" && !shareToken;',
    );
    // Leaving Chat (or signing out) closes it, so a return never starts a new recording.
    expect(app).toContain("if (!quickVoiceNoteAvailable) setVoiceNoteOpen(false);");
    expect(app).toContain("{voiceNoteOpen && quickVoiceNoteAvailable && tcw && (");
  });

  test("the chat header's labelled button opens the bar under the header", () => {
    // The button is ChatHeader's; App hands it the opener only where the bar is offered.
    const header = read("ChatHeader.tsx");
    const button = header.slice(header.indexOf("{onVoiceNote && ("), header.indexOf("</Button>", header.indexOf("{onVoiceNote && (")));
    expect(button).toContain('aria-label="Record a voice note"');
    expect(button).toContain('data-testid="header-voice-note"');
    expect(button).toContain("onClick={onVoiceNote}");
    // The header button records; it never turns a "show the running recording" bar into a new one.
    expect(app).toContain('onVoiceNote={quickVoiceNoteAvailable ? () => setVoiceNoteOpen((open) => open || "record") : undefined}');
    expect(app).toContain('autoStart={voiceNoteOpen === "record"}');
    // The bar renders under the chat header: ChatWorkspace's voiceNoteBar slot.
    const bar = app.slice(app.indexOf("voiceNoteBar={"), app.indexOf("onVoiceNote={"));
    expect(bar).toContain("<QuickVoiceNote");
    expect(bar).toContain("onOpenLibrary={() => navigate(PATHS.library)}");
    const workspace = read("ChatWorkspace.tsx");
    expect(workspace.indexOf("<ChatHeader")).toBeLessThan(workspace.indexOf("{props.voiceNoteBar}"));
    expect(workspace.indexOf("{props.voiceNoteBar}")).toBeLessThan(workspace.indexOf("<Thread\n"));
  });
});
