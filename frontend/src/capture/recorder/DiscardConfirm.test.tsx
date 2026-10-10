// Discard in the recorder's header (PR5): the quiet action, its in-place
// question, and where the sheet offers it, as server-rendered markup. Focus
// moving to Keep and the 5 s revert run in a real browser
// (test/shell-invariants.e2e.test.ts, "discard").
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { DISCARD_REVERT_MS, DiscardConfirmView } from "./DiscardConfirm";
import type { RecorderValue } from "./RecorderProvider";
import { RecordingView } from "./RecordingView";

const noop = () => {};

function value(patch: Partial<RecorderValue> = {}): RecorderValue {
  return {
    available: true,
    ready: true,
    phase: "recording",
    mic: { state: "recording", reason: null },
    startedAt: Date.now() - 42_000,
    audioMs: 42_000,
    maxDurationMs: 3_600_000,
    limitNotice: null,
    savePercent: null,
    error: null,
    outcome: null,
    lastSaved: null,
    pending: { listing: { state: "ok", count: 0 }, running: false, lastError: null },
    transcription: undefined,
    transcriber: { id: "on-device", identifySpeakers: false, source: "recording" },
    setTranscriber: async () => "ok",
    signedIn: true,
    sheetOpen: true,
    record: noop,
    stop: noop,
    pause: noop,
    resume: noop,
    discard: noop,
    retryPending: noop,
    dismissOutcome: noop,
    openSheet: noop,
    minimiseSheet: noop,
    setReceiptPlaying: noop,
    subscribeLevel: () => noop,
    ...patch,
  };
}

const sheet = (patch: Partial<RecorderValue> = {}, discardAsking?: boolean) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <RecordingView recorder={value(patch)} discardAsking={discardAsking} />
    </MemoryRouter>,
  );

const button = (html: string, testId: string) => html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>([^<]*)</button>`));

describe("DiscardConfirmView", () => {
  test("at rest: one quiet text action, Discard", () => {
    const html = renderToStaticMarkup(<DiscardConfirmView confirming={false} onAsk={noop} onKeep={noop} onDiscard={noop} />);
    expect(button(html, "recorder-discard")?.[1]).toBe("Discard");
    expect(button(html, "recorder-discard")?.[0]).toContain("text-muted-foreground");
    expect(html).not.toContain("Discard?");
    expect(html).not.toContain("bg-destructive");
  });

  test("asking: a short question that names the group in full, with Keep and a destructive Discard", () => {
    const html = renderToStaticMarkup(<DiscardConfirmView confirming onAsk={noop} onKeep={noop} onDiscard={noop} />);
    const labelledBy = html.match(/role="group" aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    // On screen "Discard?"; a screen reader hears the whole question.
    expect(html).toContain('<span aria-hidden="true">Discard?</span><span class="sr-only">Discard this recording?</span>');
    expect(button(html, "recorder-discard-keep")?.[1]).toBe("Keep");
    expect(button(html, "recorder-discard-yes")?.[1]).toBe("Discard");
    expect(button(html, "recorder-discard-yes")?.[0]).toContain("bg-destructive");
    // The action itself is replaced in place, not stacked.
    expect(button(html, "recorder-discard")).toBeNull();
  });

  test("the question turns back after 5 s", () => {
    expect(DISCARD_REVERT_MS).toBe(5000);
  });
});

describe("RecordingView's Discard", () => {
  test("only a live recording offers it in the controls", () => {
    const live = sheet();
    expect(live).toContain('data-testid="recorder-discard"');
    expect(live.indexOf('data-testid="recorder-discard"')).toBeGreaterThan(live.indexOf('data-testid="recorder-controls"'));
    expect(sheet({ mic: { state: "silenced", reason: "os_silenced" } })).toContain('data-testid="recorder-discard"');
    for (const patch of [
      { phase: "starting", startedAt: null },
      { phase: "saving", savePercent: 42 },
      { phase: "idle", startedAt: null },
      { phase: "idle", startedAt: null, outcome: "saved", lastSaved: { id: "rec-1", durationMs: 42_000, at: 0 } },
      { phase: "discarding" },
    ] satisfies Partial<RecorderValue>[]) {
      expect(sheet(patch)).not.toContain('data-testid="recorder-discard');
    }
  });

  test("asking (the harness): the question is open in the controls", () => {
    const html = sheet({}, true);
    expect(html).toContain('data-testid="recorder-discard-confirm"');
    expect(html).not.toContain('data-testid="recorder-discard"');
  });

  test("discarding: the status and the bar say so, and Stop is disabled", () => {
    const html = sheet({ phase: "discarding" });
    expect(html).toContain("Discarding…</p>");
    const stop = html.match(/<button[^>]*data-testid="voice-note-stop"[^>]*>/)?.[0] ?? "";
    expect(stop).toContain('disabled=""');
    expect(html).not.toContain('data-testid="recorder-discard"');
  });
});
