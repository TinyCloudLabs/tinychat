import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext } from "@/lib/platform";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";
import { PhoneRecorder, type PhoneRecorderProps } from "./PhoneRecorder";
import { clearNotesUi, useNotesUi, type NotesUi } from "./notes";

const noop = () => {};
const PRIVATE_ON: VoiceNoteTranscriptionProps = {
  availability: "available",
  consented: true,
  maxSeconds: 600,
  jobs: new Map(),
  onTranscribe: noop,
  onConsent: noop,
  onTurnOff: noop,
  onRecheck: noop,
};

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 1,
  audioMs: 768_000,
  elapsedMs: 768_000,
  transcription: PRIVATE_ON,
  transcriber: {
    id: "private-cloud",
    identifySpeakers: false,
    source: "recording",
  },
  sheetOpen: true,
};

const render = (
  patch: Partial<RecorderValue> = {},
  props: PhoneRecorderProps = {},
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value="ios">
        <StaticRecorderProvider value={{ ...LIVE, ...patch }}>
          <PhoneRecorder {...props} />
        </StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>,
  );

describe("PhoneRecorder", () => {
  test("recording shows the timer, the pause ring, the scale and the controls", () => {
    const html = render();
    expect(html).toContain("12:48");
    expect(html).toContain('aria-label="Pause recording"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuetext="Private"');
    expect(html).toContain('aria-label="Minimise recorder"');
    expect(html).toMatch(
      /aria-label="Transcription modes: compare and choose"[^>]*aria-haspopup="dialog"/,
    );
    expect(html).toContain('aria-label="Discard recording"');
    expect(html).toContain("Done");
    expect(html).toContain('aria-live="polite"');
  });

  test("the scale has four stops: Audio only, Local, Private and Powerful", () => {
    const html = render();
    expect((html.match(/data-available=/g) ?? []).length).toBe(4);
  });

  test("signed out, the first render has Local open and the other stops closed; signed in opens Audio only and Private (Local waits for its model)", () => {
    const stops = (patch: Partial<RecorderValue>) =>
      [...render(patch).matchAll(/data-available="(true|false)"/g)].map(
        (m) => m[1],
      );
    const local = {
      id: "on-device" as const,
      identifySpeakers: false,
      source: "recording" as const,
    };
    expect(stops({ signedIn: false, transcriber: local })).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(stops({ signedIn: true, transcriber: local })).toEqual([
      "true",
      "false",
      "true",
      "false",
    ]);
  });

  test("paused offers Resume on the ring", () => {
    const html = render({ mic: { state: "paused", reason: "user" } });
    expect(html).toContain('aria-label="Resume recording"');
    expect(html).toContain("Resting");
  });

  test("a stalled interruption has no resume ring and says why", () => {
    const html = render({ mic: { state: "interrupted", reason: "stalled" } });
    expect(html).toContain("Interrupted");
    expect(html).not.toContain('aria-label="Resume recording"');
  });

  test("the 3-hour countdown replaces the timer near the limit", () => {
    const html = render({
      elapsedMs: 170 * 60_000 + 12_000,
      audioMs: 170 * 60_000 + 12_000,
    });
    expect(html).toContain("Stops at 3:00:00");
  });

  test("denied replaces the controls with Open Settings and no recording controls", () => {
    const html = render({
      phase: "idle",
      mic: { state: "idle", reason: null },
      permissionDenied: true,
      startedAt: null,
      audioMs: 0,
      elapsedMs: 0,
    });
    expect(html).toContain("Microphone off");
    expect(html).toContain("Open Settings");
    expect(html).not.toContain('aria-label="Discard recording"');
    expect(html).not.toContain('aria-label="Record from');
  });

  test("via names the input the recording is on, from the native status", () => {
    const html = render({
      mic: {
        state: "recording",
        reason: null,
        input: { id: "bt-1", name: "AirPods Pro", kind: "bluetooth" },
      },
    });
    expect(html).toContain('aria-label="Record from AirPods Pro"');
  });

  test("busy states disable the controls", () => {
    const html = render({ phase: "saving" });
    expect(html).toContain("Saving");
    expect(html).toMatch(/aria-label="Discard recording"[^>]*disabled/);
  });

  test("the harness can open the modes card, with Identify speakers disabled while Powerful is off", () => {
    const html = render({}, { defaultOpen: "modes" });
    expect(html).toMatch(/role="dialog" aria-label="Transcription modes"/);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/role="switch"[^>]*aria-disabled="true"/);
    expect(html).toContain("Coming with the next update");
  });

  test("the Identify speakers switch shows the provider's value, and on-device takes it back to the default", () => {
    const switchChecked = (
      id: "assemblyai" | "on-device",
      identifySpeakers: boolean,
    ) =>
      render(
        { transcriber: { id, identifySpeakers, source: "recording" } },
        { defaultOpen: "modes" },
      ).match(/role="switch"[^>]*aria-checked="(true|false)"/)?.[1];
    expect(switchChecked("assemblyai", true)).toBe("true");
    expect(switchChecked("on-device", false)).toBe("false");
  });

  test("the discard sheet is an alertdialog that keeps the recording by default", () => {
    const html = render({}, { defaultOpen: "discard" });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Discard this recording?");
    expect(html).toContain("Keep recording");
    expect(html).toContain("Discard recording");
  });

  const withNote = (md: string | null): PhoneRecorderProps["notesApi"] => ({
    noteStatus: "ready",
    note: md === null ? null : { md, moments: [] },
    setNoteText: noop,
    markMoment: () => 42_000,
  });

  test("＋ notes a moment while recording", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="Note this moment"(?![^>]*disabled)/,
    );
  });

  test("View notes shows only once there is a note", () => {
    expect(render({}, { notesApi: withNote(null) })).not.toContain(
      "View notes",
    );
    expect(render({}, { notesApi: withNote("   ") })).not.toContain(
      "View notes",
    );
    expect(
      render({}, { notesApi: withNote("- **0:08** Hunter mentions the TTL") }),
    ).toContain("View notes");
  });

  test("the notes sheet is a labelled modal dialog", () => {
    const html = render(
      {},
      { notesApi: withNote("hello"), defaultOpen: "notes" },
    );
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    expect(html).toContain("Notes");
    expect(html).toContain("Write");
    expect(html).toContain("Preview");
  });

  test("the discard sheet names the notes only when there are some", () => {
    expect(render({}, { defaultOpen: "discard" })).toContain(
      "of audio. This can&#x27;t be undone.",
    );
    expect(
      render({}, { defaultOpen: "discard", notesApi: withNote("a note") }),
    ).toContain("of audio and your notes.");
  });

  describe("the note is not ready", () => {
    const status = (
      noteStatus: "loading" | "error",
    ): PhoneRecorderProps["notesApi"] => ({
      noteStatus,
      note: { md: "- **0:08** TTL", moments: [] },
      setNoteText: noop,
      markMoment: () => 42_000,
    });

    test("＋ is aria-disabled and says the note is loading", () => {
      expect(render({}, { notesApi: status("loading") })).toMatch(
        /<button[^>]*aria-label="Loading note…"[^>]*aria-disabled="true"/,
      );
    });

    test("＋ says the note could not be loaded when it errored", () => {
      expect(render({}, { notesApi: status("error") })).toMatch(
        /<button[^>]*aria-label="Your note could not be loaded\."[^>]*aria-disabled="true"/,
      );
    });

    test("the sheet shows Loading note… and a read-only, aria-disabled writer", () => {
      const html = render(
        {},
        {
          notesApi: status("loading"),
          defaultOpen: "notes",
          notesViewSeed: "write",
        },
      );
      expect(html).toContain("Loading note…");
      expect(html).toMatch(
        /<textarea[^>]*readOnly=""[^>]*aria-disabled="true"|<textarea[^>]*aria-disabled="true"[^>]*readOnly=""/,
      );
      expect(html).not.toContain('role="alert"');
    });

    test("an errored note shows a visible error line in the sheet", () => {
      const html = render(
        {},
        {
          notesApi: status("error"),
          defaultOpen: "notes",
          notesViewSeed: "write",
        },
      );
      expect(html).toMatch(/role="alert"[^>]*>Your note could not be loaded\./);
    });

    test("a ready note has an editable writer and no error line", () => {
      const html = render(
        {},
        {
          notesApi: withNote("hi"),
          defaultOpen: "notes",
          notesViewSeed: "write",
        },
      );
      expect(html).not.toContain("aria-disabled");
      expect(html).not.toContain('role="alert"');
    });
  });

  describe("a layout switch while writing", () => {
    beforeEach(clearNotesUi);
    afterEach(clearNotesUi);
    // The state the sheet left behind: LIVE's recording started at 1.
    let ui: NotesUi;
    const leaveBehind = () => {
      function Probe() {
        ui = useNotesUi(LIVE.startedAt as number);
        return null;
      }
      renderToStaticMarkup(<Probe />);
    };

    test("remounts with the sheet open on the Write view and the unsaved draft in the field", () => {
      leaveBehind();
      ui.setNoteMd("saved line");
      ui.openNotes("write");
      ui.setDraft("saved line\n\nstill typing");
      const html = render();
      expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
      expect(html).toMatch(/aria-pressed="true"[^>]*>Write/);
      expect(html).toContain("saved line\n\nstill typing");
      expect(html).toContain("View notes");
    });

    test("remounts open on the Preview view when that was showing", () => {
      leaveBehind();
      ui.setNoteMd("saved line");
      ui.openNotes("preview");
      ui.setDraft("saved line plus more");
      const html = render();
      expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
      expect(html).toMatch(/aria-pressed="true"[^>]*>Preview/);
      expect(html).not.toContain("<textarea");
      expect(html).toContain("nt-fmd-loading");
    });

    test("a note typed in the sheet is still there with the sheet closed", () => {
      leaveBehind();
      ui.setNoteMd("- **0:08** TTL");
      expect(render()).toContain("View notes");
    });

    test("after Done or discard the next recording starts clean", () => {
      leaveBehind();
      ui.setNoteMd("old note");
      ui.openNotes("write");
      clearNotesUi();
      const html = render();
      expect(html).not.toContain("View notes");
      expect(html).not.toContain('aria-modal="true"');
    });
  });
});
