// The minimised recorder: the island in each state, and the rail, sidebar and
// header controls that stand in for it.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MinimizedProvider } from "./final/MinimizedProvider";
import { HeaderLiveChipView } from "./HeaderLiveChip";
import { IslandView, islandState } from "./Island";
import { RailLiveButtonView } from "./RailLiveButton";
import { RecordButton } from "./RecordButton";
import { islandShown, StaticRecorderProvider, type RecorderValue } from "./RecorderProvider";
import { SidebarLiveCardView } from "./SidebarLiveCard";

const noop = () => {};

function value(patch: Partial<RecorderValue> = {}): RecorderValue {
  return {
    available: true,
    ready: true,
    phase: "recording",
    mic: { state: "recording", reason: null },
    startedAt: Date.now() - (12 * 60 + 48) * 1000,
    audioMs: (12 * 60 + 48) * 1000,
    maxDurationMs: 3_600_000,
    limitNotice: null,
    savePercent: null,
    error: null,
    outcome: null,
    lastSaved: null,
    pending: { listing: { state: "ok", count: 0 }, running: false, lastError: null },
    transcription: undefined,
    signedIn: true,
    sheetOpen: false,
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

describe("IslandView", () => {
  test("live: the time, Recording, an Open recorder area and its own Stop (never voice-note-stop)", () => {
    const html = renderToStaticMarkup(<IslandView recorder={value()} />);
    expect(html).toContain('data-state="live"');
    expect(html).toContain(">12:48</span>");
    expect(html).toContain(">Recording</span>");
    expect(html).toContain('aria-label="Open recorder"');
    expect(html).toContain('aria-label="Stop and save"');
    expect(html).toContain('data-testid="island-stop"');
    expect(html).not.toContain('data-testid="voice-note-stop"');
  });

  test("a mic problem shows in the island too", () => {
    expect(renderToStaticMarkup(<IslandView recorder={value({ mic: { state: "silenced", reason: "os_silenced" } })} />)).toContain("Mic problem");
  });

  test("saving: the percentage, no Stop", () => {
    const html = renderToStaticMarkup(<IslandView recorder={value({ phase: "saving", savePercent: 42 })} />);
    expect(html).toContain("Saving · 42%");
    expect(html).not.toContain("island-stop");
  });

  test("landed: Saved on this phone, with Open when a note can be opened", () => {
    const landed = value({ phase: "idle", outcome: "saved", lastSaved: { id: "rec-1", durationMs: 1, at: 1 } });
    const html = renderToStaticMarkup(<IslandView recorder={landed} onOpenNote={noop} />);
    expect(html).toContain("Saved on this phone");
    expect(html).toContain('data-testid="island-open"');
    expect(renderToStaticMarkup(<IslandView recorder={landed} />)).not.toContain("island-open");
  });

  test("failed: Kept on this phone, with Save now", () => {
    const html = renderToStaticMarkup(<IslandView recorder={value({ phase: "idle", outcome: "failed" })} />);
    expect(html).toContain("Kept on this phone");
    expect(html).toContain('data-testid="island-save-now"');
  });

  test("shown while minimised and under way or just ended; never over the open sheet or when idle", () => {
    expect(islandShown(value())).toBe(true);
    expect(islandShown(value({ sheetOpen: true }))).toBe(false);
    expect(islandShown(value({ phase: "idle" }))).toBe(false);
    expect(islandShown(value({ phase: "idle", outcome: "saved" }))).toBe(true);
    expect(islandState(value({ phase: "starting" }))).toBe("live");
    expect(islandState(value({ phase: "stopping" }))).toBe("saving");
  });
});

describe("the other live controls", () => {
  test("rail: a named button with the time", () => {
    const html = renderToStaticMarkup(<RailLiveButtonView recorder={value()} />);
    expect(html).toContain('data-testid="rail-live"');
    expect(html).toContain('aria-label="Recording. Open recorder"');
    expect(html).toContain(">12:48</span>");
  });

  test("sidebar: the time and Open", () => {
    const html = renderToStaticMarkup(<SidebarLiveCardView recorder={value()} />);
    expect(html).toContain('data-testid="sidebar-live"');
    expect(html).toContain(">12:48</span>");
    expect(html).toContain(">Open</button>");
  });

  test("header chip: only shown by CSS while the keyboard is open", () => {
    const html = renderToStaticMarkup(
      <StaticRecorderProvider value={value()}>
        <MinimizedProvider>
          <HeaderLiveChipView recorder={value()} />
        </MinimizedProvider>
      </StaticRecorderProvider>,
    );
    expect(html).toContain("hidden");
    expect(html).toContain("[html[data-keyboard=open]_&amp;]:inline-flex");
    expect(html).toContain('aria-label="Recording. Open recorder"');
  });
});

describe("Record while a receipt is showing", () => {
  const render = (patch: Partial<RecorderValue>, variant: "icon" | "action") =>
    renderToStaticMarkup(
      <StaticRecorderProvider value={value({ phase: "idle", startedAt: null, ...patch })}>
        <RecordButton variant={variant} />
      </StaticRecorderProvider>,
    );

  test("idle: Capture's Record and the header mic record", () => {
    expect(render({}, "action")).toContain('data-testid="voice-note-record"');
    expect(render({}, "action")).toContain('aria-label="Record a voice note"');
    expect(render({}, "icon")).toContain('aria-label="Record a voice note"');
  });

  test("a saved or failed receipt, or a recording under way: both open the recorder instead", () => {
    for (const patch of [{ outcome: "saved" as const }, { outcome: "failed" as const }, { phase: "recording" as const }]) {
      const action = render(patch, "action");
      expect(action).toContain('aria-label="Open recorder"');
      expect(action).not.toContain('data-testid="voice-note-record"');
      expect(render(patch, "icon")).toContain('aria-label="Open recorder"');
    }
  });

  test("nothing outside the phone app", () => {
    expect(render({ available: false }, "action")).toBe("");
  });
});
