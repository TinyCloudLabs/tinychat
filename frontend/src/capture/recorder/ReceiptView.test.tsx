import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PlatformContext } from "@/lib/platform";

import { ReceiptView, receiptRouting } from "./ReceiptView";
import { StaticRecorderProvider } from "./RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";
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
  dismissOutcome: noop, openSheet: noop, minimiseSheet: noop, setReceiptPlaying: noop, tcw: null,
  subscribeLevel: () => noop, ...patch,
});

const render = (patch: Partial<RecorderValue> = {}, platform: "ios" | "tauri" = "ios") => renderToStaticMarkup(
  <PlatformContext.Provider value={platform}>
    <StaticRecorderProvider value={recorder(patch)}>
      <MemoryRouter><ReceiptView recorder={recorder(patch)} /></MemoryRouter>
    </StaticRecorderProvider>
  </PlatformContext.Provider>,
);

describe("ReceiptView", () => {
  test("a recording that ended shows the phone receipt, with no recording controls", () => {
    const html = render({ phase: "idle", outcome: "local", startedAt: null,
      lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() } });
    expect(html).toContain("Saved on this iPhone");
    expect(html).toContain(">0:42</span>");
    // The old saving line is gone: the pipeline stepper takes its place once the note has been read.
    expect(html).not.toContain("Saving to your TinyCloud space…");
    expect(html).toContain('data-testid="recorder-minimise"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
    expect(html).not.toContain('data-testid="voice-note-pause"');
  });

  test("a committed Mac recording names the Mac before its space upload finishes", () => {
    const html = render({ phase: "idle", outcome: "local", startedAt: null,
      lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() } }, "tauri");
    expect(html).toContain('data-testid="voice-note-status-label"');
    expect(html).toContain("Saved on this Mac");
    expect(html).toContain('aria-label="Saved on this Mac"');
    expect(html).not.toContain("Saved on this iPhone");
  });

  test("a legacy Mac note without localAudio is ready rather than preparing", () => {
    const html = render({ phase: "idle", outcome: "local", startedAt: null,
      lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() } }, "tauri");
    expect(html).not.toContain("Preparing audio");
    expect(html).toContain("Getting this Mac&#x27;s audio");
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

  test("a note held back from transcription is not announced as transcribing", () => {
    const route = (jobs: NonNullable<RecorderValue["transcription"]>["jobs"]) => render({ phase: "idle", outcome: "saved", startedAt: null,
      lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() },
      transcription: { availability: "available", consented: true, maxSeconds: 600, jobs, onTranscribe: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop } });
    const active = route(new Map([["rec-1", { kind: "active", status: { kind: "waiting" } }]]));
    // Before the native ledger resolves, the receipt cannot claim a route from a job alone.
    expect(active).toContain("Getting this iPhone&#x27;s audio…");
    expect(active).not.toContain("Transcribing in private cloud…");
    const held = route(new Map([["rec-1", { kind: "held", message: "Held: not sent for transcription" }]]));
    expect(held).not.toContain("Transcribing in private cloud…");
    expect(held).toContain('data-testid="voice-note-held"');
    expect(held).toContain("Held: not sent for transcription");
    expect(route(new Map())).not.toContain('data-testid="voice-note-held"');
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

describe("receiptRouting: where a saved note stands", () => {
  const saved = { id: "rec-1", durationMs: 42_000, at: Date.now() };
  const transcription = (patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps => ({
    availability: "available", consented: true, maxSeconds: 7_200, jobs: new Map(),
    onTranscribe: noop, onTranscribePrivately: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop, ...patch,
  });
  const jobs = (kind: "active" | "failed") =>
    new Map([["rec-1", kind === "active" ? { kind } : { kind, message: "busy" }]]) as unknown as VoiceNoteTranscriptionProps["jobs"];
  const route = (patch: Partial<Parameters<typeof receiptRouting>[0]> = {}) =>
    receiptRouting({ outcome: "saved", lastSaved: saved, transcription: transcription(), savedTranscriber: "on-device", ...patch });

  test("a Local note with Private available is not in private cloud, and offers Use Private instead", () => {
    expect(route()).toMatchObject({ transcribing: false, movedToPrivate: false, savedRoute: "on-device", canUsePrivate: true });
  });

  test("a Local note with Private unavailable offers no switch", () => {
    for (const patch of [{ availability: "failed" as const }, { consented: false }, { maxSeconds: 10 }]) {
      expect(route({ transcription: transcription(patch) })).toMatchObject({ savedRoute: "on-device", canUsePrivate: false });
    }
    expect(route({ transcription: undefined }).canUsePrivate).toBe(false);
  });

  test("a Local note that was only saved here (not yet in the space) offers no switch", () => {
    expect(route({ outcome: "local" })).toMatchObject({ canUsePrivate: false, savedRoute: "on-device" });
  });

  test("once moved, the route is private cloud; it is transcribing only while its job is active", () => {
    expect(route({ transcription: transcription({ jobs: jobs("active") }) }))
      .toMatchObject({ movedToPrivate: true, transcribing: true, savedRoute: "private-cloud", canUsePrivate: false });
    expect(route({ transcription: transcription({ jobs: jobs("failed") }) }))
      .toMatchObject({ movedToPrivate: true, transcribing: false, savedRoute: "private-cloud", canUsePrivate: true });
  });

  const finished = (outcome: "transcribed" | "no_speech") =>
    new Map([["rec-1", { kind: "done", outcome }]]) as unknown as VoiceNoteTranscriptionProps["jobs"];

  test("a Private note reads as transcribing only while its job runs", () => {
    expect(route({ savedTranscriber: "private-cloud", transcription: transcription({ jobs: jobs("active") }) }))
      .toMatchObject({ transcribing: true, savedRoute: "private-cloud", canUsePrivate: false });
    // Availability alone is not work in progress, and the mode lookup may not have answered yet.
    expect(route({ savedTranscriber: "private-cloud" })).toMatchObject({ transcribing: false });
    expect(route({ savedTranscriber: null })).toMatchObject({ transcribing: false, savedRoute: "off" });
  });

  test("Audio only is off and transcribes nothing, however available Private is", () => {
    expect(route({ savedTranscriber: "off" })).toMatchObject({ transcribing: false, savedRoute: "off", privateOutcome: null });
    expect(route({ savedTranscriber: "off", transcription: undefined })).toMatchObject({ transcribing: false, savedRoute: "off" });
  });

  test("a finished Private job stays on the private route and is no longer transcribing", () => {
    expect(route({ savedTranscriber: "private-cloud", transcription: transcription({ jobs: finished("transcribed") }) }))
      .toMatchObject({ transcribing: false, savedRoute: "private-cloud", privateOutcome: "transcribed" });
    expect(route({ savedTranscriber: "private-cloud", transcription: transcription({ jobs: finished("no_speech") }) }))
      .toMatchObject({ transcribing: false, privateOutcome: "no_speech" });
    expect(route({ transcription: transcription({ jobs: finished("transcribed") }) }))
      .toMatchObject({ movedToPrivate: true, transcribing: false, privateOutcome: "transcribed", savedRoute: "private-cloud" });
  });

  test("a failed Private job is not transcribing and stays on the private route", () => {
    expect(route({ savedTranscriber: "private-cloud", transcription: transcription({ jobs: jobs("failed") }) }))
      .toMatchObject({ transcribing: false, savedRoute: "private-cloud" });
  });
});
