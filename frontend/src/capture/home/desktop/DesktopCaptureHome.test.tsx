// The desktop Capture home: the markup of each state, rendered statically.
import { describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext, type AppPlatform } from "@/lib/platform";
import type { InProgressRowsViewProps } from "../../InProgressRows";
import type { LibraryItem } from "../../library/LibraryRow";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../../recorder/RecorderProvider";
import {
  DesktopCaptureHome,
  FilterChips,
  RecentRow,
  type DesktopCaptureHomeProps,
} from "./DesktopCaptureHome";

const noop = () => {};
const NOW = new Date(2026, 9, 9, 9, 41);
const idle: InProgressRowsViewProps = {
  upload: null,
  paused: null,
  meetings: [],
  busyId: null,
  onOpenUpload: noop,
  onContinue: noop,
  onOpenMeeting: noop,
  onEnd: noop,
};
const voice = (count: number): InProgressRowsViewProps => ({
  ...idle,
  voice: {
    listing: { state: "ok", count },
    saving: false,
    lastError: null,
    limitNotice: null,
    onSaveNow: noop,
  },
});
const note = (i: number): LibraryItem => ({
  id: `row-${i}`,
  source: "exo-voice-note",
  sourceId: `rec-${i}`,
  title: `Voice note · Oct 9, 1:${50 - i} AM`,
  startedAt: new Date(2026, 9, 9, 1, 50 - i).toISOString(),
  durationSecs: 60 * i + 5,
});

function home(
  options: {
    platform?: AppPlatform;
    layout?: "rail" | "desktop";
    recorder?: Partial<RecorderValue>;
    props?: Partial<DesktopCaptureHomeProps>;
  } = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value={options.platform ?? "tauri"}>
        <StaticRecorderProvider value={options.recorder}>
          <DesktopCaptureHome
            tcw={{} as TinyCloudWeb}
            backendUrl="http://localhost"
            sessionStore={{} as SessionStore}
            layout={options.layout ?? "desktop"}
            inProgress={idle}
            recent={{ status: "ready", items: [] }}
            onRetryRecent={noop}
            onUpload={noop}
            onMeeting={noop}
            now={NOW}
            {...options.props}
          />
        </StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>,
  );
}

describe("header", () => {
  test("Capture, Library, and the settings button", () => {
    const html = home();
    expect(html).toMatch(/<h1[^>]*>Capture<\/h1>/);
    expect(html).toContain('href="/chat/capture/library"');
    expect(html).toContain('data-testid="capture-settings-button"');
  });

  test("the web has the button too (microphone only); the desktop app and the web both can connect meetings", () => {
    const html = home({ platform: "web" });
    expect(html).toContain('data-testid="capture-settings-button"');
    expect(html).toContain("Connect existing meetings");
  });
});

describe("hero", () => {
  test("idle: a decorative ring (40 ticks, aria-hidden, out of the tab order) and Start recording", () => {
    const html = home();
    expect(html).toMatch(/<button[^>]*tabindex="-1"[^>]*aria-hidden="true"[^>]*>/);
    expect(html).toContain('aria-label="Start recording a voice note"');
    expect(html).toContain(">Start recording<");
    expect(html).toContain('data-testid="voice-note-record"');
    expect(html).not.toContain("Back to recording");
  });

  test("Start waits until the recorder has heard what is already running", () => {
    expect(home({ recorder: { ready: false } })).toMatch(/<button[^>]*disabled=""[^>]*data-testid="voice-note-record"/);
  });

  test("docked: Back to recording · m:ss, no ring, no announcement of its own", () => {
    const html = home({ recorder: { phase: "recording", elapsedMs: 42_000 } });
    expect(html).toContain("Back to recording");
    expect(html).toContain("0:42");
    expect(html).toContain('data-testid="capture-open-recorder"');
    expect(html).toContain('aria-label="Back to recording"');
    expect(html).not.toContain(">Start recording<");
    expect(html).not.toContain('aria-hidden="true" disabled');
    expect(html).not.toContain("aria-live");
  });
});

describe("actions", () => {
  test("Upload and Meeting; Meeting is left out while the notetaker is dark", () => {
    const html = home();
    expect(html).toContain('data-testid="capture-upload"');
    expect(html).toContain('data-testid="capture-meeting"');
    expect(home({ props: { onMeeting: undefined } })).not.toContain('data-testid="capture-meeting"');
  });
});

describe("the on-this-Mac card", () => {
  test("the desktop app: a count, 'Not in your space yet' and Save now", () => {
    const html = home({ props: { inProgress: voice(2) } });
    expect(html).toContain("2 voice notes on this Mac");
    expect(html).toContain("Not in your space yet");
    expect(html).toContain('data-testid="voice-note-retry"');
    expect(html).not.toContain("on this phone");
  });

  test("the web: no card, and never the phone row either", () => {
    const html = home({ platform: "web", props: { inProgress: voice(2) } });
    expect(html).not.toContain("voice-note-pending");
    expect(html).not.toContain("on this Mac");
    expect(html).not.toContain("on this phone");
  });

  test("nothing waiting, no card", () => {
    expect(home({ props: { inProgress: voice(0) } })).not.toContain("on this Mac");
  });
});

describe("Recent", () => {
  test("empty: one dim line", () => {
    expect(home()).toContain("Your recordings appear here");
  });

  test("rows under their day: tile, title, meta, duration and chevron, one link", () => {
    const html = home({ props: { recent: { status: "ready", items: [note(1)] } } });
    expect(html).toContain(">Today<");
    expect(html).toContain('href="/chat/capture/library/row-1"');
    expect(html).toContain("1:05");
    expect(html).toContain('data-testid="recent-item"');
  });

  test("a voice note with part of its audio missing says so, and offers Dismiss", () => {
    const html = home({
      recorder: { captureIssues: { "rec-1": { kind: "partial_audio", missingMs: 3000 } } },
      props: { recent: { status: "ready", items: [note(1), note(2)] } },
    });
    expect(html).toContain("Saved — part of this recording couldn&#x27;t be written");
    expect(html.match(/data-testid="capture-issue-dismiss"/g)).toHaveLength(1);
    expect(html).toContain("Dismiss the notice for Voice note · Oct 9, 1:49 AM");
    expect(html).not.toContain("Needs attention");
  });

  test("a recording with no Library row yet shows its failure, never its detail", () => {
    const html = home({
      recorder: { captureIssues: { orphan: { kind: "recoveryFailed", detail: "ENOSPC /var/x" } } },
    });
    expect(html).toContain("Couldn&#x27;t recover this recording");
    expect(html).toContain("Needs attention");
    expect(html).not.toContain("ENOSPC");
    expect(html).not.toContain("capture-issue-dismiss");
  });

  test("an orphan with partial audio is a voice note row with Dismiss", () => {
    const html = home({ recorder: { captureIssues: { orphan: { kind: "partial_audio" } } } });
    expect(html).toContain(">Voice note<");
    expect(html).toContain("Saved — part of this recording couldn&#x27;t be written");
    expect(html).toContain('data-testid="capture-issue-dismiss"');
    expect(html).not.toContain("Your recordings appear here");
  });

  test("loading and failed keep their own states", () => {
    expect(home({ props: { recent: { status: "loading", items: [] } } })).toContain("Loading your recent captures…");
    const failed = home({ props: { recent: { status: "failed", items: [] } } });
    expect(failed).toContain("Couldn’t load your recent captures.");
    expect(failed).not.toContain("Your recordings appear here");
  });
});

describe("filter chips", () => {
  test("a toggle group: the active chip is pressed and checked", () => {
    const html = renderToStaticMarkup(<FilterChips value="note" onChange={noop} />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Filter recent captures"');
    expect(html).toMatch(/aria-pressed="true"[^>]*><svg[^>]*>.*<\/svg>Notes/);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
  });
});

describe("a row", () => {
  test("a voice note's row carries its recording id", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ul>
          <RecentRow
            entry={{ type: "item", item: note(3), startedAt: note(3).startedAt }}
            now={NOW}
            grouped
            onDismiss={noop}
          />
        </ul>
      </MemoryRouter>,
    );
    expect(html).toContain('data-source-id="rec-3"');
  });
});
