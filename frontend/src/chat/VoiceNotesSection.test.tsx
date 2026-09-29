// The VOICE NOTES card. `VoiceNotesView` is a pure function of its props, so the product rules
// are asserted against real markup via react-dom/server (no DOM harness in this workspace):
//   1. idle says the microphone is off and offers Record;
//   2. recording shows the elapsed time and Stop;
//   3. what the OS reports is told, never hidden: silenced and no-signal read as warnings;
//   4. a load failure is not rendered as "no voice notes";
//   5. notes still only on the phone are told, with a way to save them;
//   6. outside the native app the section renders nothing.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  VoiceNotesSection,
  VoiceNotesView,
  formatDuration,
  type VoiceNotesViewProps,
} from "./VoiceNotesSection";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const noop = () => {};

function render(patch: Partial<VoiceNotesViewProps> = {}): string {
  return renderToStaticMarkup(
    <VoiceNotesView
      phase="idle"
      mic={{ state: "idle", reason: null }}
      elapsedMs={0}
      level={0}
      error={null}
      notes={[]}
      notesStatus="ready"
      playing={null}
      pendingCount={0}
      retrying={false}
      onRecord={noop}
      onStop={noop}
      onPlay={noop}
      onRetry={noop}
      {...patch}
    />,
  );
}

describe("VoiceNotesView", () => {
  test("idle offers Record and says the microphone is off", () => {
    const html = render();
    expect(html).toContain('data-testid="voice-note-record"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
    expect(html).toContain("Not recording. The microphone is off.");
    expect(html).toContain("No voice notes yet.");
  });

  test("recording shows elapsed time and Stop", () => {
    const html = render({ phase: "recording", mic: { state: "recording", reason: null }, elapsedMs: 65_000 });
    expect(html).toContain('data-testid="voice-note-stop"');
    expect(html).toContain('data-mic-state="recording"');
    expect(html).toContain("Recording 1:05");
  });

  test("an OS-silenced capture is a visible warning, not a normal recording", () => {
    const html = render({ phase: "recording", mic: { state: "silenced", reason: "os_silenced" }, elapsedMs: 3_000 });
    expect(html).toContain('data-mic-state="silenced"');
    expect(html).toContain("the system is blocking the microphone");
  });

  test("zero input level while live says no sound is arriving", () => {
    const html = render({ phase: "recording", mic: { state: "recording", reason: "no_signal" }, elapsedMs: 3_000 });
    expect(html).toContain('data-mic-reason="no_signal"');
    expect(html).toContain("no sound is reaching the microphone");
  });

  test("a failed list load is told, never shown as an empty list", () => {
    const html = render({ notesStatus: "error" });
    expect(html).toContain("Could not load your voice notes.");
    expect(html).not.toContain("No voice notes yet.");
  });

  test("saved notes list with duration, and the open one gets a player", () => {
    const html = render({
      notes: [{ id: "row-1", sourceId: "rec-1", title: "Voice note · Sep 29, 5:40 AM", startedAt: "2026-09-29T05:40:00.000Z", durationSecs: 12 }],
      playing: { sourceId: "rec-1", src: "data:audio/mp4;base64,AAAA" },
    });
    expect(html).toContain('data-source-id="rec-1"');
    expect(html).toContain("0:12");
    expect(html).toContain('data-testid="voice-note-player"');
  });
});

describe("VoiceNotesView pending saves", () => {
  test("nothing pending shows no banner", () => {
    expect(render()).not.toContain('data-testid="voice-note-pending"');
  });

  test("notes left on the phone are told, with Save now", () => {
    const one = render({ pendingCount: 1 });
    expect(one).toContain("1 note is on this phone but not yet in your");
    expect(one).toContain('data-testid="voice-note-retry"');
    expect(render({ pendingCount: 3 })).toContain("3 notes are on this phone");
  });

  test("Save now is disabled while a retry runs", () => {
    expect(render({ pendingCount: 1, retrying: true })).toMatch(/<button[^>]*disabled[^>]*data-testid="voice-note-retry"/);
  });
});

describe("formatDuration", () => {
  test("minutes and zero-padded seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9_999)).toBe("0:09");
    expect(formatDuration(600_000)).toBe("10:00");
  });
});

describe("VoiceNotesSection", () => {
  test("renders nothing outside the Exo mobile app", () => {
    expect(renderToStaticMarkup(<VoiceNotesSection tcw={{} as TinyCloudWeb} />)).toBe("");
  });
});
