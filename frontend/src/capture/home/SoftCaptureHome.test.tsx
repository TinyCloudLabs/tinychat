// Capture home and its rows in the Soft skin (TC-871): the markup of each state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { LibraryListView } from "../library/LibraryListView";
import { LibraryRow, type LibraryItem } from "../library/LibraryRow";
import type { InProgressRowsViewProps } from "../InProgressRows";
import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import { StaticRecorderProvider } from "../recorder/RecorderProvider";
import { SoftActions } from "./SoftActions";
import { SoftCaptureHome, type SoftCaptureHomeProps } from "./SoftCaptureHome";
import { SoftHomeProvider } from "./softHome";

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
const note = (i: number, patch: Partial<LibraryItem> = {}): LibraryItem => ({
  id: `row-${i}`,
  source: "exo-voice-note",
  sourceId: `rec-${i}`,
  title: `Voice note · Oct 9, 1:${50 - i} AM`,
  startedAt: new Date(2026, 9, 9, 1, 50 - i).toISOString(),
  durationSecs: 60 * i + 5,
  ...patch,
});

function home(
  patch: Partial<SoftCaptureHomeProps> = {},
  issues: Record<string, RecorderCaptureIssue> = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SoftHomeProvider enabled issues={issues}>
        <SoftCaptureHome
          inProgress={idle}
          recent={{ status: "ready", items: [] }}
          scanFailure={null}
          onRetryRecent={noop}
          now={NOW}
          {...patch}
        />
      </SoftHomeProvider>
    </MemoryRouter>,
  );
}

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

describe("Recent", () => {
  test("empty: one dim line, no illustration", () => {
    const html = home();
    expect(html).toContain("Your recordings appear here");
    expect(html).toContain(">See all<");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });

  test("rows: a mic tile, the title, time, the length and a chevron, as one link", () => {
    const html = home({ recent: { status: "ready", items: [note(1)] } });
    expect(html).toContain('data-testid="recent-item"');
    expect(html).toContain("Voice note · Oct 9, 1:49 AM");
    expect(html).toContain("1:05");
    expect(html).toContain('href="/chat/capture/library/row-1"');
    expect(html).toMatch(
      /aria-label="Voice note · Oct 9, 1:49 AM\. [^"]*1 min"/,
    );
  });

  test("shows the last five", () => {
    const html = home({
      recent: {
        status: "ready",
        items: [1, 2, 3, 4, 5, 6, 7].map((i) => note(i)),
      },
    });
    expect(html.match(/data-testid="recent-item"/g)).toHaveLength(5);
  });

  test("loading and failed keep their own states", () => {
    expect(home({ recent: { status: "loading", items: [] } })).toContain(
      "Loading your recent captures…",
    );
    const failed = home({ recent: { status: "failed", items: [] } });
    expect(failed).toContain("Couldn’t load your recent captures.");
    expect(failed).not.toContain("Your recordings appear here");
  });
});

describe("the on-this-phone card", () => {
  test("app only: a count, 'Not in your space yet' and Save now", () => {
    const html = home({ inProgress: voice(2) });
    expect(html).toContain("2 voice notes on this phone");
    expect(html).toContain("Not in your space yet");
    expect(html).toContain('data-testid="voice-note-retry"');
    expect(html).toContain("In progress");
  });

  test("one note is singular; no card where the recorder does not exist or nothing is waiting", () => {
    expect(home({ inProgress: voice(1) })).toContain(
      "1 voice note on this phone",
    );
    expect(home({ inProgress: voice(0) })).not.toContain("on this phone");
    expect(home()).not.toContain("on this phone");
  });

  test("recoveryFailed overrides 'Exo will finish it automatically'", () => {
    const html = home(
      { inProgress: voice(2) },
      {
        a: { kind: "finalization_timed_out" },
        b: { kind: "recoveryFailed", detail: "x" },
      },
    );
    expect(html).toContain("Exo will retry when it next opens");
    expect(html).not.toContain("automatically");
  });
});

describe("capture-issue rows", () => {
  const timedOut = { kind: "finalization_timed_out" } as const;
  const failed = { kind: "recoveryFailed", detail: "ENOSPC" } as const;
  const writeFailed = { kind: "write_failed", detail: "EIO" } as const;

  test("timed out: 'Saving… · kept on this phone' with a spinner, not a sheet", () => {
    const html = home({}, { "rec-9": timedOut });
    expect(html).toContain("Saving… · kept on this phone");
    expect(html).toContain('data-testid="soft-row-spinner"');
    expect(html).toContain('data-issue="finalization_timed_out"');
    expect(html).not.toContain("<button");
    expect(html).toContain(
      'aria-label="Voice note. Saving… · kept on this phone"',
    );
  });

  test("recovery failed: a '!' tile, its line, announced in the label, and a button for the sheet", () => {
    const html = home({}, { "rec-9": failed });
    expect(html).toContain('<span class="soft-tile-bang">!</span>');
    expect(html).toContain("Couldn&#x27;t recover this recording");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Opens details");
    expect(html).toMatch(/<button[^>]*class="soft-row"/);
    expect(html).not.toContain("ENOSPC");
  });

  test("write failed: its own honest line", () => {
    const html = home({}, { "rec-9": writeFailed });
    expect(html).toContain("Couldn&#x27;t save all of this recording");
    expect(html).not.toContain("EIO");
  });

  test("a Library row for the same recording is decorated and not repeated", () => {
    const html = home(
      { recent: { status: "ready", items: [note(1)] } },
      { "rec-1": failed },
    );
    expect(html.match(/data-testid="recent-item"/g)).toHaveLength(1);
    expect(html).toContain("Voice note · Oct 9, 1:49 AM");
    expect(html).toContain("Couldn&#x27;t recover this recording");
  });

  test("an issue row replaces the empty line", () => {
    expect(home({}, { "rec-9": timedOut })).not.toContain(
      "Your recordings appear here",
    );
  });
});

describe("the scan failure", () => {
  test("one quiet card above Recent, and the detail is not shown", () => {
    const html = home({ scanFailure: "scan_io_error: /var/mobile" });
    expect(html).toContain(
      "Exo couldn&#x27;t check for unfinished recordings. It will try again when it next opens.",
    );
    expect(html).not.toContain("scan_io_error");
    expect(html.indexOf("recovery-scan-failure")).toBeLessThan(
      html.indexOf('data-testid="capture-recent"'),
    );
    expect(html).not.toContain("aria-live");
  });
  test("absent when the check worked", () => {
    expect(home()).not.toContain("recovery-scan-failure");
  });
});

describe("LibraryRow", () => {
  const row = (provider: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        {provider ? (
          <SoftHomeProvider enabled issues={{}}>
            <LibraryRow item={note(1)} now={NOW} grouped />
          </SoftHomeProvider>
        ) : (
          <LibraryRow item={note(1)} now={NOW} grouped />
        )}
      </MemoryRouter>,
    );
  test("is the Soft row only inside the Soft home; everywhere else it is the row it was", () => {
    expect(row(true)).toContain("soft-row");
    expect(row(false)).not.toContain("soft-");
    expect(row(false)).toContain('data-testid="voice-note-item"');
    expect(row(true)).toContain('data-testid="voice-note-item"');
    expect(row(true)).toContain('data-source-id="rec-1"');
  });
  test("a disabled provider is the row it was", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SoftHomeProvider enabled={false} issues={{}}>
          <LibraryRow item={note(1)} now={NOW} grouped />
        </SoftHomeProvider>
      </MemoryRouter>,
    );
    expect(html).not.toContain("soft-");
  });
});

describe("actions", () => {
  const actions = (
    value: Parameters<typeof StaticRecorderProvider>[0]["value"],
    meeting = true,
  ) =>
    renderToStaticMarkup(
      <StaticRecorderProvider value={value}>
        <SoftActions onUpload={noop} onMeeting={meeting ? noop : undefined} />
      </StaticRecorderProvider>,
    );
  test("Upload · Recorder · Meeting, Recorder the primary pill", () => {
    const html = actions({ available: true, ready: true });
    expect(html.indexOf("Upload")).toBeLessThan(html.indexOf("Recorder"));
    expect(html.indexOf("Recorder")).toBeLessThan(html.indexOf("Meeting"));
    expect(html).toContain("soft-act soft-act-main");
    expect(html).toContain('data-testid="voice-note-record"');
  });
  test("under way it reopens the recorder; before ready it waits; no recorder, no pill", () => {
    expect(
      actions({ available: true, ready: true, phase: "recording" }),
    ).toContain('data-testid="capture-open-recorder"');
    expect(actions({ available: true, ready: false })).toMatch(
      /disabled=""[^>]*data-testid="voice-note-record"|data-testid="voice-note-record"[^>]*disabled=""/,
    );
    expect(actions({ available: false })).not.toContain("soft-act-main");
    expect(actions({ available: true, ready: true }, false)).not.toContain(
      "capture-meeting",
    );
  });
});

describe("Library list", () => {
  const library = (
    issues: Record<string, RecorderCaptureIssue>,
    options: {
      soft?: boolean;
      filter?: "all" | "note" | "meeting";
      items?: LibraryItem[];
    } = {},
  ) => {
    const list = (
      <LibraryListView
        status="ready"
        items={options.items ?? [note(1), note(2)]}
        filter={options.filter ?? "all"}
        onFilterChange={noop}
        onRetry={noop}
        now={NOW}
      />
    );
    return renderToStaticMarkup(
      <MemoryRouter>
        {options.soft === false ? (
          list
        ) : (
          <SoftHomeProvider enabled issues={issues}>
            {list}
          </SoftHomeProvider>
        )}
      </MemoryRouter>,
    );
  };
  const failed: RecorderCaptureIssue = { kind: "recoveryFailed", detail: "x" };

  test("a recording with an issue and no row shows above the days, as a row that opens its sheet", () => {
    const html = library({ "rec-lost": failed });
    expect(html).toContain('data-source-id="rec-lost"');
    expect(html).toContain('data-issue="recoveryFailed"');
    expect(html).toContain("Couldn&#x27;t recover this recording");
    expect(html.indexOf("rec-lost")).toBeLessThan(
      html.indexOf("Voice note · Oct 9, 1:49 AM"),
    );
  });

  test("a recording that has its row is decorated, not shown twice", () => {
    const html = library({ "rec-1": { kind: "write_failed", detail: "x" } });
    expect(html.match(/data-source-id="rec-1"/g)).toHaveLength(1);
    expect(html).toContain('data-issue="write_failed"');
  });

  test("the meetings filter leaves voice-note issues out; the empty Library still lists them", () => {
    expect(
      library({ "rec-lost": failed }, { filter: "meeting" }),
    ).not.toContain("rec-lost");
    const empty = library({ "rec-lost": failed }, { items: [] });
    expect(empty).toContain('data-source-id="rec-lost"');
    expect(empty).not.toContain("Nothing here yet.");
  });

  test("the Soft skin off: the Library list is unchanged", () => {
    expect(library({ "rec-lost": failed }, { soft: false })).not.toContain(
      "rec-lost",
    );
  });
});
