import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { LevelTrace } from "./LevelTrace";
import { RecordingView } from "./RecordingView";
import type { RecorderValue } from "./RecorderProvider";

const noop = () => {};
const recorder = (patch: Partial<RecorderValue> = {}): RecorderValue => ({
  available: true, ready: true, phase: "recording", permissionDenied: false, mic: { state: "recording", reason: null },
  startedAt: Date.now() - 42_000, audioMs: 42_000, maxDurationMs: 3 * 60 * 60_000,
  limitNotice: null, savePercent: null, error: null, outcome: null, lastSaved: null,
  pending: { listing: { state: "ok", count: 0 }, running: false, lastError: null },
  transcription: undefined, signedIn: true, sheetOpen: true,
  record: noop, stop: noop, pause: noop, resume: noop, discard: noop, retryPending: noop, openSettings: async () => {},
  dismissOutcome: noop, openSheet: noop, minimiseSheet: noop, setReceiptPlaying: noop,
  subscribeLevel: () => noop, ...patch,
});

const render = (patch: Partial<RecorderValue> = {}) => renderToStaticMarkup(
  <MemoryRouter><RecordingView recorder={recorder(patch)} /></MemoryRouter>,
);

describe("RecordingView", () => {
  test("a full-page recording shows the native audio clock, waveform, Stop, Pause and Discard", () => {
    const html = render();
    expect(html).toContain(">0:42</span>");
    expect(html).toContain('data-variant="waveform"');
    expect(html).toContain('data-testid="voice-note-stop"');
    expect(html).toContain('data-testid="voice-note-pause"');
    expect(html).toContain('data-testid="recorder-discard"');
  });

  test("denied shortcut shows the full-page recovery action without recording controls", () => {
    const html = render({ phase: "idle", permissionDenied: true, startedAt: null });
    expect(html).toContain("Microphone access is off");
    expect(html).toContain('data-testid="voice-note-open-settings"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
  });

  test("shows the routed microphone reported by native capture", () => {
    const html = render({ mic: { state: "recording", reason: null,
      input: { id: "15:Phone mic", name: "Phone mic", kind: "built_in" } } });
    expect(html).toContain('data-testid="recorder-active-input"');
    expect(html).toContain("Using Phone mic");
  });

  test("paused freezes the trace and offers Resume; interrupted makes Resume prominent", () => {
    const paused = render({ mic: { state: "paused", reason: "user" } });
    expect(paused).toContain("Paused · microphone off");
    expect(paused).toContain('data-testid="voice-note-resume"');
    expect(paused).toContain('data-variant="waveform"');
    expect(render({ mic: { state: "needs_user", reason: "resume_blocked" } })).toContain('data-testid="voice-note-resume-main"');
  });

  test("the limit hint follows recorded audio time, excluding a long pause", () => {
    const html = render({ startedAt: Date.now() - 3 * 60 * 60_000, audioMs: 42_000,
      mic: { state: "paused", reason: "user" } });
    expect(html).toContain(">0:42</span>");
    expect(html).not.toContain("Stops at 3:00:00");
  });

  test("native commit shows the phone receipt before space upload completes", () => {
    const html = render({ phase: "idle", outcome: "local", startedAt: null,
      lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() } });
    expect(html).toContain("Saved on this phone");
    expect(html).toContain("Saving to your TinyCloud space…");
    expect(html).not.toContain('data-testid="voice-note-stop"');
  });

  test("the waveform has 96 bars and is hidden from assistive technology", () => {
    const html = renderToStaticMarkup(<LevelTrace subscribe={() => noop} variant="waveform" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<span /g)?.length).toBe(96);
  });
});
