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
import { clearNotesUi, readNotesUi, updateNotesUi } from "./notes";

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
  recordingId: "rec-1",
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
      recordingId: null,
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

  const withNote = (md: string | null): Partial<RecorderValue> => ({
    noteStatus: "ready",
    note: md === null ? null : { md, moments: [] },
  });
  const KEY = LIVE.recordingId as string;

  beforeEach(clearNotesUi);
  afterEach(clearNotesUi);

  test("＋ notes a moment while recording", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="Note this moment"(?![^>]*disabled)/,
    );
  });

  test("View notes shows only once there is a note", () => {
    expect(render(withNote(null))).not.toContain("View notes");
    expect(render(withNote("   "))).not.toContain("View notes");
    expect(render(withNote("- **0:08** Hunter mentions the TTL"))).toContain(
      "View notes",
    );
  });

  test("the notes sheet is a labelled modal dialog", () => {
    const html = render(withNote("hello"), { defaultOpen: "notes" });
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
      render(withNote("a note"), { defaultOpen: "discard" }),
    ).toContain("of audio and your notes.");
  });

  describe("the note is not ready", () => {
    const status = (noteStatus: "loading" | "error"): Partial<RecorderValue> => ({
      noteStatus,
      note: null,
    });
    const write = { defaultOpen: "notes", notesViewSeed: "write" } as const;

    test("＋ is aria-disabled and says the note is loading", () => {
      expect(render(status("loading"))).toMatch(
        /<button[^>]*aria-label="Loading note…"[^>]*aria-disabled="true"/,
      );
    });

    test("＋ says the note could not be loaded when it errored", () => {
      expect(render(status("error"))).toMatch(
        /<button[^>]*aria-label="Your note could not be loaded\."[^>]*aria-disabled="true"/,
      );
    });

    test("opening Write while the note loads mounts no field, so nothing empty can be saved over it", () => {
      const html = render(status("loading"), write);
      expect(html).toContain("Loading note…");
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain('role="alert"');
    });

    test("when the note arrives the field is there with the loaded text", () => {
      expect(render(status("loading"), write)).not.toContain("<textarea");
      const html = render(withNote("- **0:08** loaded from disk"), write);
      expect(html).toMatch(/<textarea[^>]*>- \*\*0:08\*\* loaded from disk</);
      expect(html).not.toContain("aria-disabled");
    });

    test("a draft typed before the note arrived is what the field starts with", () => {
      updateNotesUi(KEY, () => ({
        draft: "typed earlier",
        open: true,
        view: "write",
      }));
      const html = render(withNote("saved"));
      expect(html).toMatch(/<textarea[^>]*>typed earlier</);
    });

    test("an errored note shows a visible error line and no field", () => {
      const html = render(status("error"), write);
      expect(html).toMatch(/role="alert"[^>]*>Your note could not be loaded\./);
      expect(html).not.toContain("<textarea");
    });

    test("a ready note has an editable writer and no error line", () => {
      const html = render(withNote("hi"), write);
      expect(html).toContain("<textarea");
      expect(html).not.toContain("aria-disabled");
      expect(html).not.toContain('role="alert"');
    });
  });

  describe("a failed save is visible above the sheet", () => {
    const failed = () =>
      updateNotesUi(KEY, () => ({ saveFailed: true, draft: "unsaved words" }));

    test("with the sheet closed the recorder shows an alert and the View notes control says so", () => {
      failed();
      const html = render(withNote("saved"));
      expect(html).toMatch(/role="alert"[^>]*>Note not saved\./);
      expect(html).toMatch(/class="pr-vnotes"[^>]*data-failed="true"[^>]*>.*Note not saved/s);
      expect(html).not.toMatch(/>View notes</);
    });

    test("with the sheet open the alert is in the sheet, once", () => {
      failed();
      updateNotesUi(KEY, () => ({ open: true, view: "write" }));
      const html = render(withNote("saved"));
      expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
      expect(html).toContain("could not be saved");
      expect(html).toMatch(/<textarea[^>]*>unsaved words</);
    });

    test("a note that saved fine shows neither", () => {
      const html = render(withNote("saved"));
      expect(html).not.toContain("Note not saved");
      expect(html).toContain("View notes");
    });
  });

  describe("the note could not be synced", () => {
    const sync = (code: string | null): Partial<RecorderValue> => ({
      ...withNote("a note"),
      noteSyncError: code,
    });

    test("shows Note not synced yet, never the code", () => {
      const html = render(sync("sync_rejected"));
      expect(html).toContain("Note not synced yet");
      expect(html).not.toContain("sync_rejected");
    });

    test("shows nothing when there is no error", () => {
      expect(render(sync(null))).not.toContain("Note not synced yet");
    });
  });

  describe("a layout switch while writing", () => {
    // The state the sheet left behind: LIVE's recording started at 1.
    test("remounts with the sheet open on the Write view and the unsaved draft in the field", () => {
      updateNotesUi(KEY, () => ({
        open: true,
        view: "write",
        draft: "saved line\n\nstill typing",
      }));
      const html = render(withNote("saved line"));
      expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
      expect(html).toMatch(/aria-pressed="true"[^>]*>Write/);
      expect(html).toContain("saved line\n\nstill typing");
      expect(html).toContain("View notes");
    });

    test("remounts open on the Preview view when that was showing", () => {
      updateNotesUi(KEY, () => ({
        open: true,
        view: "preview",
        draft: "saved line plus more",
      }));
      const html = render(withNote("saved line"));
      expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"/);
      expect(html).toMatch(/aria-pressed="true"[^>]*>Preview/);
      expect(html).not.toContain("<textarea");
      expect(html).toContain("nt-fmd-loading");
    });

    test("a note typed in the sheet is still there with the sheet closed", () => {
      expect(render(withNote("- **0:08** TTL"))).toContain("View notes");
    });

    test("another recording starts clean", () => {
      updateNotesUi(KEY, () => ({ open: true, view: "write", draft: "old" }));
      const html = render({ ...withNote(null), recordingId: "rec-2" });
      expect(html).not.toContain("View notes");
      expect(html).not.toContain('aria-modal="true"');
      expect(readNotesUi("rec-2")).toBeNull();
    });
  });
});
