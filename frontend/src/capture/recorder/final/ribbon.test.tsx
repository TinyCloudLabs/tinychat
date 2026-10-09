// The minimised recorder (TC-870): the Ribbon, the sidebar dock and the Capture item's dot, in each state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FinalHeaderLiveChip } from "../HeaderLiveChip";
import {
  StaticRecorderProvider,
  useRecorder,
  type RecorderValue,
} from "../RecorderProvider";
import { CaptureDot } from "./CaptureDot";
import { MinimizedProvider } from "./MinimizedProvider";
import { RibbonView } from "./Ribbon";
import { SidebarDockView } from "./SidebarDock";

const minutes = (m: number, s = 0) => (m * 60 + s) * 1000;

/** A whole RecorderValue, as the provider builds it, with `patch` on top. */
function recorderWith(patch: Partial<RecorderValue>): RecorderValue {
  let seen: RecorderValue | null = null;
  const Grab = () => {
    seen = useRecorder();
    return null;
  };
  renderToStaticMarkup(
    <StaticRecorderProvider value={patch}>
      <Grab />
    </StaticRecorderProvider>,
  );
  return seen!;
}

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 0,
  audioMs: minutes(0, 6),
  elapsedMs: minutes(0, 6),
};
const PAUSED: Partial<RecorderValue> = {
  ...LIVE,
  mic: { state: "paused", reason: "user" },
  elapsedMs: minutes(0, 15),
};
const INTERRUPTED: Partial<RecorderValue> = {
  ...LIVE,
  mic: { state: "interrupted", reason: "call" },
};

const ribbon = (
  patch: Partial<RecorderValue>,
  elapsedMs = patch.elapsedMs ?? 0,
  extra: { announcement?: string; entering?: boolean } = {},
) =>
  renderToStaticMarkup(
    <RibbonView
      recorder={recorderWith(patch)}
      elapsedMs={elapsedMs}
      theme="night"
      {...extra}
    />,
  );
const dock = (
  patch: Partial<RecorderValue>,
  elapsedMs = patch.elapsedMs ?? 0,
) =>
  renderToStaticMarkup(
    <SidebarDockView
      recorder={recorderWith(patch)}
      elapsedMs={elapsedMs}
      theme="night"
    />,
  );
const bars = (html: string) => (html.match(/data-bar="/g) ?? []).length;

describe("RibbonView", () => {
  test("recording: one labelled control for the timer and bars, Pause, and a Stop that saves", () => {
    const html = ribbon(LIVE);
    expect(html).toContain('data-state="live"');
    expect(html).toContain(">0:06</span>");
    expect(html).toContain('aria-label="Recording. Open recorder"');
    expect(html).toContain('aria-label="Pause recording"');
    expect(html).toContain('aria-label="Stop and save"');
    expect(html).toContain('data-testid="ribbon-open"');
  });

  test("the timer and bars share one button, and no control is nested in it", () => {
    const html = ribbon(LIVE);
    const open = html.slice(
      html.indexOf('data-testid="ribbon-open"'),
      html.indexOf("</button>", html.indexOf('data-testid="ribbon-open"')),
    );
    expect(open).toContain("ribbon-timer");
    expect(open).toContain("ribbon-bars");
    expect(open).not.toContain("<button");
  });

  test("no discard and no notes", () => {
    const html = ribbon(LIVE);
    expect(html).not.toMatch(/discard|notes/i);
    expect(html.match(/<button/g)).toHaveLength(3);
  });

  test("paused: Resume in place of Pause, the timer dims, the bars hold", () => {
    const html = ribbon(PAUSED);
    expect(html).toContain('data-state="paused"');
    expect(html).toContain('data-live="false"');
    expect(html).toContain('aria-label="Resume recording"');
    expect(html).not.toContain('aria-label="Pause recording"');
    expect(html).toContain('aria-label="Paused. Open recorder"');
    expect(html).toContain(">0:15</span>");
  });

  test("30 bars, hidden from assistive technology", () => {
    expect(bars(ribbon(LIVE))).toBe(30);
    expect(ribbon(LIVE)).toContain('data-spectrum-bars="" data-paused="false"');
    expect(ribbon(PAUSED)).toContain('data-paused="true"');
  });

  test("interrupted: not live, so no red recording state", () => {
    const html = ribbon(INTERRUPTED);
    expect(html).toContain('data-live="false"');
    expect(html).not.toContain('data-state="live"');
  });

  test("a mic that cannot be paused or resumed leaves the toggle disabled", () => {
    const html = ribbon({ ...INTERRUPTED, controlPending: "pause" });
    expect(html).toContain('disabled=""');
  });

  test("the polite live region carries the announcement and is empty otherwise", () => {
    expect(ribbon(LIVE, 6000, { announcement: "Minimized" })).toContain(
      'role="status" class="sr-only" data-testid="minimized-announcement">Minimized<',
    );
    expect(ribbon(LIVE)).toContain(
      'data-testid="minimized-announcement"></span>',
    );
  });

  test("entering is the only state that carries the entrance class", () => {
    expect(ribbon(LIVE, 6000, { entering: true })).toContain("is-entering");
    expect(ribbon(LIVE)).not.toContain("is-entering");
  });
});

describe("SidebarDockView", () => {
  test("22 bars", () => {
    expect(bars(dock(LIVE))).toBe(22);
  });

  test("recording: the time, Pause, Stop, Listening and an open control", () => {
    const html = dock(LIVE);
    expect(html).toContain('data-testid="sidebar-dock"');
    expect(html).toContain(">0:06</span>");
    expect(html).toContain('aria-label="Recording. Open recorder"');
    expect(html).toContain('aria-label="Pause recording"');
    expect(html).toContain('aria-label="Stop and save"');
    expect(html).toContain(">Listening</span>");
  });

  test("the open control is not a parent of Pause or Stop", () => {
    const html = dock(LIVE);
    const open = html.slice(
      html.indexOf('data-testid="dock-open"'),
      html.indexOf("</button>", html.indexOf('data-testid="dock-open"')),
    );
    expect(open).not.toContain("dock-pause");
    expect(open).not.toContain("dock-stop");
  });

  test("paused: Resume, and the pill says so", () => {
    const html = dock(PAUSED);
    expect(html).toContain('aria-label="Resume recording"');
    expect(html).toContain('data-state="paused"');
    expect(html).toContain(
      'data-testid="dock-status">Resting · tap to continue<',
    );
  });

  test("interrupted: not live", () => {
    expect(dock(INTERRUPTED)).toContain('data-live="false"');
  });
});

function withProvider(
  patch: Partial<RecorderValue>,
  children: React.ReactNode,
) {
  return renderToStaticMarkup(
    <StaticRecorderProvider value={patch}>
      <MinimizedProvider>{children}</MinimizedProvider>
    </StaticRecorderProvider>,
  );
}

describe("CaptureDot", () => {
  test("red while live", () => {
    const html = withProvider(LIVE, <CaptureDot />);
    expect(html).toContain('data-dot="live"');
    expect(html).toContain(", recording");
  });

  test("grey while paused", () => {
    expect(withProvider(PAUSED, <CaptureDot />)).toContain('data-dot="paused"');
  });

  test("hollow, never red, when the mic is interrupted", () => {
    const html = withProvider(INTERRUPTED, <CaptureDot />);
    expect(html).toContain('data-dot="hollow"');
    expect(html).not.toContain('data-dot="live"');
  });

  test("nothing when idle, after the recording, or outside the final recorder", () => {
    expect(withProvider({}, <CaptureDot />)).toBe("");
    expect(
      withProvider({ phase: "saving", savePercent: 10 }, <CaptureDot />),
    ).toBe("");
    expect(renderToStaticMarkup(<CaptureDot />)).toBe("");
  });
});

describe("FinalHeaderLiveChip", () => {
  test("the elapsed time and a red dot while live; grey when paused; hollow when interrupted", () => {
    const chip = (patch: Partial<RecorderValue>) =>
      withProvider(
        patch,
        <FinalHeaderLiveChip recorder={recorderWith(patch)} />,
      );
    expect(chip(LIVE)).toContain("0:06");
    expect(chip(LIVE)).toContain("rounded-full bg-live");
    expect(chip(PAUSED)).toContain("bg-muted-foreground");
    expect(chip(INTERRUPTED)).toContain("border-[1.5px]");
    expect(chip(INTERRUPTED)).not.toContain("bg-live");
  });
});
