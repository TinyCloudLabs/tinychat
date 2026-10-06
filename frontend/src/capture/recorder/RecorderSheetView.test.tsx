// The recorder sheet's states (ported from QuickVoiceNote's view cases) and its
// level trace and receipt, as server-rendered markup.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { LevelTrace } from "./LevelTrace";
import type { RecorderValue } from "./RecorderProvider";
import { RecorderSheetView, transcribesSaved } from "./RecorderSheet";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

const noop = () => {};
const off = () => noop;

function value(patch: Partial<RecorderValue> = {}): RecorderValue {
  return {
    available: true,
    ready: true,
    phase: "recording",
    mic: { state: "recording", reason: null },
    startedAt: Date.now() - 42_000,
    maxDurationMs: 3_600_000,
    limitNotice: null,
    savePercent: null,
    error: null,
    outcome: null,
    lastSaved: null,
    pending: { listing: { state: "ok", count: 0 }, running: false, lastError: null },
    transcription: undefined,
    sheetOpen: true,
    record: noop,
    stop: noop,
    discard: noop,
    retryPending: noop,
    dismissOutcome: noop,
    openSheet: noop,
    minimiseSheet: noop,
    subscribeLevel: off,
    ...patch,
  };
}

function render(patch: Partial<RecorderValue> = {}, onOpenNote?: (id: string) => void): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RecorderSheetView recorder={value(patch)} onOpenNote={onOpenNote} />
    </MemoryRouter>,
  );
}

const stopButton = (html: string) => html.match(/<button[^>]*data-testid="voice-note-stop"[^>]*>/)?.[0] ?? "";
const disabled = (button: string) => / disabled=""/.test(button);

describe("RecorderSheetView", () => {
  test("starting: says so, and Stop is there but disabled until the recorder has started", () => {
    const html = render({ phase: "starting", startedAt: null });
    expect(html).toContain("Starting the microphone…");
    expect(disabled(stopButton(html))).toBe(true);
  });

  test("recording: status, the time, the meta line, and an enabled Stop and save", () => {
    const html = render();
    expect(html).toContain('data-mic-state="recording"');
    expect(html).toContain(">Recording</span>");
    expect(html).toContain(">0:42</span>");
    expect(html).toContain("Voice note · started");
    expect(disabled(stopButton(html))).toBe(false);
    expect(html).toContain("Stop and save");
    expect(html).toContain('aria-label="Minimise recorder"');
  });

  test("silenced and no-signal are warnings with the card's own sentence", () => {
    const silenced = render({ mic: { state: "silenced", reason: "os_silenced" } });
    expect(silenced).toContain('data-mic-state="silenced"');
    expect(silenced).toContain('data-mic-reason="os_silenced"');
    expect(silenced).toContain(">Mic silenced</span>");
    expect(silenced).toContain("The system is blocking the microphone (a call, another app, or the mic privacy toggle).");
    const quiet = render({ mic: { state: "recording", reason: "no_signal" } });
    expect(quiet).toContain('data-mic-reason="no_signal"');
    expect(quiet).toContain(">No sound</span>");
    expect(quiet).toContain("No sound is reaching the microphone.");
  });

  test("near the limit the meta line says when it stops", () => {
    expect(render({ startedAt: Date.now() - 56 * 60_000 })).toContain("Stops at 60:00");
  });

  test("saving: the percentage, and Stop shows a spinner and is disabled", () => {
    const html = render({ phase: "saving", savePercent: 42 });
    expect(html).toContain("Saving to your space · 42%");
    expect(disabled(stopButton(html))).toBe(true);
    // Disabled, it reads as a neutral status bar at full contrast, not a faded live one.
    expect(stopButton(html)).toContain("disabled:bg-surface-2 disabled:text-foreground disabled:opacity-100");
    expect(html).toContain("Saving…");
  });

  test("an error (a failed start) is an alert, with Record to try again", () => {
    const html = render({ phase: "idle", startedAt: null, error: "permission_denied" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("permission_denied");
    expect(html).toContain('data-testid="recorder-record-again"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
  });

  test("landed: the receipt replaces the route control and the Stop bar", () => {
    const html = render({ phase: "idle", outcome: "saved", startedAt: null, lastSaved: { id: "rec-1", durationMs: 42_000, at: Date.now() } }, noop);
    expect(html).toContain("Saved to your TinyCloud space");
    expect(html).toContain('data-testid="voice-note-receipt-open"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
    expect(html).not.toContain('data-testid="transcription-route"');
  });

  test("failed: kept on the phone, with Save now", () => {
    const html = render({ phase: "idle", outcome: "failed", startedAt: null, error: "Recorded, but saving to your space failed: offline" });
    expect(html).toContain("Kept on this phone. Not in your space yet.");
    expect(html).toContain("Recorded, but saving to your space failed: offline");
    expect(html).toContain('data-testid="voice-note-retry"');
  });

  test("the receipt says private cloud is transcribing only when it will", () => {
    const on: VoiceNoteTranscriptionProps = { availability: "available", consented: true, maxSeconds: 600, jobs: new Map(), onTranscribe: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop };
    const saved = { id: "rec-1", durationMs: 42_000, at: 0 };
    expect(transcribesSaved({ transcription: on, lastSaved: saved })).toBe(true);
    expect(transcribesSaved({ transcription: { ...on, consented: false }, lastSaved: saved })).toBe(false);
    expect(transcribesSaved({ transcription: on, lastSaved: { ...saved, durationMs: 11 * 60_000 } })).toBe(false);
    expect(transcribesSaved({ transcription: undefined, lastSaved: saved })).toBe(false);
  });
});

describe("LevelTrace", () => {
  test("48 bars by default, hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<LevelTrace subscribe={off} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<span /g)?.length).toBe(48);
    expect(renderToStaticMarkup(<LevelTrace subscribe={off} bars={12} />).match(/<span /g)?.length).toBe(12);
  });
});

describe("SavedReceipt", () => {
  test("saved: the headline, the meta line, the landed route, Open and Done", () => {
    const html = renderToStaticMarkup(
      <SavedReceipt outcome="saved" saved={{ durationMs: 42_000, at: new Date(2026, 9, 6, 9, 41).getTime() }} route={voiceNoteRoute(true)} transcribing onOpen={noop} onDone={noop} onSaveNow={noop} />,
    );
    expect(html).toContain("Saved to your TinyCloud space");
    expect(html).toContain("Voice note · 0:42 · ");
    expect(html).toContain("data-landed");
    expect(html).toContain("Transcribing in private cloud…");
    expect(html).toContain(">Open</button>");
    expect(html).toContain(">Done</button>");
  });

  test("failed: never claims the note is in the space", () => {
    const html = renderToStaticMarkup(<SavedReceipt outcome="failed" route={voiceNoteRoute(false)} onDone={noop} onSaveNow={noop} />);
    expect(html).toContain("Kept on this phone. Not in your space yet.");
    expect(html).not.toContain("data-landed");
    expect(html).toContain("Save now");
  });
});
