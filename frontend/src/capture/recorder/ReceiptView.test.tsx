import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { ReceiptView } from "./ReceiptView";
import type { RecorderValue } from "./RecorderProvider";
import { FINALIZATION_PENDING } from "./recorderCopy";
import { HOME_COPY } from "../home/homeCopy";

const noop = () => {};
const recorder = (patch: Partial<RecorderValue> = {}): RecorderValue => ({
  available: true, ready: true, phase: "idle", permissionDenied: false, mic: { state: "recording", reason: null },
  startedAt: Date.now() - 42_000, audioMs: 42_000, maxDurationMs: 3 * 60 * 60_000,
  limitNotice: null, savePercent: null, error: null, outcome: null, lastSaved: null,
  pending: { listing: { state: "ok", count: 0 }, running: false, lastError: null },
  transcription: undefined, signedIn: true, sheetOpen: true,
  captureIssues: {}, transcriber: { id: "on-device", identifySpeakers: false, source: "recording" },
  setTranscriber: async () => "ok",
  record: noop, stop: noop, pause: noop, resume: noop, discard: noop, retryPending: noop, openSettings: async () => {},
  dismissOutcome: noop, openSheet: noop, minimiseSheet: noop, setReceiptPlaying: noop,
  subscribeLevel: () => noop, ...patch,
});

const render = (patch: Partial<RecorderValue> = {}) => renderToStaticMarkup(
  <MemoryRouter><ReceiptView recorder={recorder(patch)} /></MemoryRouter>,
);

describe("ReceiptView", () => {
  test("a recording that ended shows the phone receipt, with no recording controls", () => {
    const html = render({ phase: "idle", outcome: "local", startedAt: null,
      lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() } });
    expect(html).toContain("Saved on this phone");
    expect(html).toContain(">0:42</span>");
    expect(html).toContain("Saving to your TinyCloud space…");
    expect(html).toContain('data-testid="recorder-minimise"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
    expect(html).not.toContain('data-testid="voice-note-pause"');
  });

  test("denied shortcut shows the full-page recovery action without a receipt", () => {
    const html = render({ phase: "idle", permissionDenied: true, startedAt: null });
    expect(html).toContain("Microphone access is off");
    expect(html).toContain('data-testid="voice-note-open-settings"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
  });

  test("without an outcome there is no receipt to show", () => {
    expect(() => render({ phase: "idle", outcome: null, startedAt: null })).toThrow("ReceiptView mounted without an outcome");
  });

  describe("the receipt's error line is the honest one", () => {
    const escaped = (text: string) => text.replace("'", "&#x27;");
    const receipt = (patch: Partial<RecorderValue>) => render({ phase: "idle", outcome: "local", startedAt: null,
      lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() }, error: FINALIZATION_PENDING, ...patch });

    test("a failed recovery replaces the finishing promise", () => {
      const html = receipt({ finalizationPendingId: "rec-1", captureIssues: { "rec-1": { kind: "recoveryFailed", detail: "ENOSPC" } } });
      expect(html).toContain(escaped(HOME_COPY.recoveryFailedError));
      expect(html).not.toContain("finish it automatically");
      expect(html).not.toContain("ENOSPC");
    });

    test("a failed write replaces the finishing promise", () => {
      const html = receipt({ finalizationPendingId: "rec-1", captureIssues: { "rec-1": { kind: "write_failed", detail: "EIO" } } });
      expect(html).toContain(escaped(HOME_COPY.writeFailedError));
      expect(html).not.toContain("finish it automatically");
    });

    test("with no failure the finishing promise stays", () => {
      expect(receipt({ finalizationPendingId: "rec-1", captureIssues: {} })).toContain("finish it automatically");
    });
  });
});
