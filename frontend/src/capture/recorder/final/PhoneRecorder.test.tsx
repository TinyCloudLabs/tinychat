import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext } from "@/lib/platform";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";
import { PhoneRecorder, type PhoneRecorderProps } from "./PhoneRecorder";

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
const storage = { getItem: () => null, setItem: noop };

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 1,
  audioMs: 768_000,
  elapsedMs: 768_000,
  transcription: PRIVATE_ON,
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
          <PhoneRecorder storage={storage} {...props} />
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

  test("the scale has four stops: Skip, Local, Private and Powerful", () => {
    const html = render();
    expect((html.match(/data-available=/g) ?? []).length).toBe(4);
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

  test("the discard sheet is an alertdialog that keeps the recording by default", () => {
    const html = render({}, { defaultOpen: "discard" });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Discard this recording?");
    expect(html).toContain("Keep recording");
    expect(html).toContain("Discard recording");
  });
});
