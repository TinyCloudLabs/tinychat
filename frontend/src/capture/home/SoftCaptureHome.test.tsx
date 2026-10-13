// Capture home and its rows in the Soft skin (TC-871): the markup of each state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { LibraryListView } from "../library/LibraryListView";
import { LibraryRow, libraryRowBadge, type LibraryItem } from "../library/LibraryRow";
import { withOnPhone } from "../library/onPhone";
import type { InProgressRowsViewProps } from "../InProgressRows";
import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import { StaticRecorderProvider } from "../recorder/RecorderProvider";
import { SoftActions } from "./SoftActions";
import { SoftCaptureHome, type SoftCaptureHomeProps } from "./SoftCaptureHome";
import { SoftHomeProvider } from "./softHome";
import { HOME_COPY } from "./homeCopy";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";

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
const pipeline = (caption = "Uploading audio to your TinyCloud space · 42%", patch: Partial<NotePipeline> = {}): NotePipeline => ({
  steps: [
    { key: "phone", label: "On this phone", state: "done" },
    { key: "space", label: "In your space", state: "active", caption, progress: 0.42 },
    { key: "transcript", label: "Transcript", state: "upcoming" },
    { key: "notes", label: "Notes", state: "skipped" },
  ], current: "space", done: false, ...patch,
});
const waitingPipeline = (patch: Partial<NotePipeline> = {}): NotePipeline => pipeline("Waiting for upload", {
  current: "space",
  steps: [
    { key: "phone", label: "On this phone", state: "done" },
    { key: "space", label: "In your space", state: "waiting", caption: "Waiting for upload" },
    { key: "transcript", label: "Transcript", state: "upcoming" },
    { key: "notes", label: "Notes", state: "skipped" },
  ],
  ...patch,
});

function home(
  patch: Partial<SoftCaptureHomeProps> = {},
  issues: Record<string, RecorderCaptureIssue> = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SoftHomeProvider enabled issues={issues} onDismissIssue={() => true}>
        <SoftCaptureHome
          inProgress={idle}
          recent={{ status: "ready", items: [] }}
          scanFailure={null}
          onRetryRecent={noop}
          onPipelineAction={noop}
          onOpenLibrary={noop}
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
    online: true,
    pendingNotes: Array.from({ length: count }, (_, i) => ({ id: `rec-${i + 1}`, upload: { state: "waiting" as const } })),
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
    expect(html).toContain(">Voice note</b>");
    expect(html).not.toContain("Oct 9, 1:49 AM");
    expect(html).toContain("Today 1:49 AM · 1:05");
    expect(html).toContain('href="/chat/capture/library/row-1"');
    expect(html).toMatch(/aria-label="Voice note\. Today 1:49 AM · 1:05"/);
  });

  test("a note still on this phone is a row of its own with its badge", () => {
    const onPhone = note(1, { id: "on-phone:rec-1", title: null, onPhone: true });
    const html = home({ recent: { status: "ready", items: [onPhone, note(2)] }, pipelines: new Map([["rec-1", pipeline()]]) });
    expect(html.match(/data-testid="recent-item"/g)).toHaveLength(2);
    expect(html).toContain('href="/chat/capture/library/on-phone%3Arec-1"');
    expect(html.match(/data-pipeline-track-summary=/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Voice note. Audio on this phone: Saved. Audio in your space: Uploading audio to your TinyCloud space · 42%. Transcript: Not started. Today 1:49 AM · 1:05"');
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

  test("a failed save uses the pipeline action and no longer shows the Saving badge", () => {
    const recent = withOnPhone([note(1)], [
      { id: "rec-1", startedAt: Date.parse("2026-10-09T01:49:00.000Z"), durationMs: 65_000, failed: { kind: "offline", message: "still offline" } },
    ]);
    const failed = pipeline("", { current: "space", blocker: { cause: "Couldn't reach your space. This note is safe on this phone.", action: { kind: "retry", label: "Try again" } } });
    const html = home({ inProgress: voice(1), recent: { status: "ready", items: recent }, pipelineNotes: recent, pipelines: new Map([["rec-1", failed]]) });
    expect(html).not.toContain(">Saving…<");
    expect(html).toContain('data-testid="voice-note-action"');
    expect(html).toContain(">Try again<");
  });
});

describe("the in-progress card", () => {
  test("shows every unfinished pipeline row and no Save now when notes are moving", () => {
    const a = note(1, { id: "on-phone:rec-1", sourceId: "rec-1", title: null, onPhone: true });
    const b = note(2, { id: "on-phone:rec-2", sourceId: "rec-2", title: null, onPhone: true });
    const html = home({ inProgress: voice(2), recent: { status: "ready", items: [a, b] }, pipelineNotes: [a, b], pipelines: new Map([["rec-1", pipeline()], ["rec-2", pipeline("Waiting to upload", { steps: [
      { key: "phone", label: "Audio on this phone", state: "done" }, { key: "space", label: "Audio in your space", state: "waiting", caption: "Waiting to upload" }, { key: "transcript", label: "Transcript", state: "done", sublabel: "Ready on this phone" }, { key: "notes", label: "Notes", state: "skipped" },
    ] })]]) });
    expect(html).toContain('data-testid="voice-note-summary">2 in progress</b>');
    expect(html).toContain('data-testid="voice-note-on-phone">2 on this phone</span>');
    expect(html).toContain('data-testid="voice-note-uploading">1 uploading</span>');
    expect(html).toContain("Waiting to upload");
    expect(html).toContain("Transcript: Ready on this phone");
    expect(html).not.toContain("Save now");
    expect(html).toContain("In progress");
  });

  test("shows Save now for an online idle note waiting on the space step", () => {
    const waiting = waitingPipeline();
    const item = note(1, { id: "on-phone:rec-1", title: null, onPhone: true });
    const html = home({ inProgress: voice(1), recent: { status: "ready", items: [item] }, pipelineNotes: [item], pipelines: new Map([["rec-1", waiting]]) });
    expect(html).toContain('data-testid="voice-note-save-now"');
    expect(html).toContain(`>${HOME_COPY.saveNow}<`);
  });

  test("hides Save now for a pending-note upload even when its pipeline is waiting", () => {
    const item = note(1, { id: "on-phone:rec-1", title: null, onPhone: true });
    const idleVoice = voice(1).voice!;
    const uploadingVoice: InProgressRowsViewProps = {
      ...voice(1),
      voice: { ...idleVoice, pendingNotes: [{ id: "rec-1", upload: { state: "uploading" } }] },
    };
    const html = home({ inProgress: uploadingVoice, recent: { status: "ready", items: [item] }, pipelineNotes: [item], pipelines: new Map([["rec-1", waitingPipeline()]]) });
    expect(html).not.toContain('data-testid="voice-note-save-now"');
  });

  test("hides Save now while offline", () => {
    const item = note(1, { id: "on-phone:rec-1", title: null, onPhone: true });
    const onlineVoice = voice(1).voice!;
    const offline: InProgressRowsViewProps = { ...voice(1), voice: { ...onlineVoice, online: false } };
    const html = home({ inProgress: offline, recent: { status: "ready", items: [item] }, pipelineNotes: [item], pipelines: new Map([["rec-1", waitingPipeline()]]) });
    expect(html).not.toContain('data-testid="voice-note-save-now"');
  });

  test("hides Save now while a save is running", () => {
    const item = note(1, { id: "on-phone:rec-1", title: null, onPhone: true });
    const onlineVoice = voice(1).voice!;
    const saving: InProgressRowsViewProps = { ...voice(1), voice: { ...onlineVoice, saving: true } };
    const html = home({ inProgress: saving, recent: { status: "ready", items: [item] }, pipelineNotes: [item], pipelines: new Map([["rec-1", waitingPipeline()]]) });
    expect(html).not.toContain('data-testid="voice-note-save-now"');
  });

  test("a blocker action takes precedence over Save now", () => {
    const item = note(1, { id: "on-phone:rec-1", title: null, onPhone: true });
    const blocked = waitingPipeline({ blocker: { cause: "Couldn't reach your space", action: { kind: "retry", label: "Try again" } } });
    const html = home({ inProgress: voice(1), recent: { status: "ready", items: [item] }, pipelineNotes: [item], pipelines: new Map([["rec-1", blocked]]) });
    expect(html).toContain('data-testid="voice-note-action"');
    expect(html).not.toContain('data-testid="voice-note-save-now"');
  });

  test("does not show a card after every note is done", () => {
    const done = pipeline("", { done: true, current: null });
    expect(home({ recent: { status: "ready", items: [note(1)] }, pipelineNotes: [note(1)], pipelines: new Map([["rec-1", done]]) })).not.toContain('data-testid="voice-note-pending"');
  });
});

describe("capture-issue rows", () => {
  const timedOut = { kind: "finalization_timed_out" } as const;
  const failed = { kind: "recoveryFailed", detail: "ENOSPC" } as const;
  const writeFailed = { kind: "write_failed", detail: "EIO" } as const;

  test("timed out: 'Saving… · kept on this phone' with a spinner, as one button that opens its sheet", () => {
    const html = home({}, { "rec-9": timedOut });
    expect(html).toContain("Saving… · kept on this phone");
    expect(html).toContain('data-testid="soft-row-spinner"');
    expect(html).toContain('data-issue="finalization_timed_out"');
    expect(html).toMatch(/<button[^>]*class="soft-row"/);
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain("Needs attention");
    expect(html).toContain(
      'aria-label="Voice note. Saving… · kept on this phone. Opens details"',
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
    expect(html).toContain(">Voice note</b>");
    expect(html).toContain(`<span class="tnum">1:05</span>`); // its line is the failure, so its length moves aside
    expect(html).toContain("Couldn&#x27;t recover this recording");
  });

  describe("partial audio: saved, with part of it missing", () => {
    const partial = { kind: "partial_audio", missingMs: 12_000 } as const;
    const recent = () => home({ recent: { status: "ready", items: [note(1)] } }, { "rec-1": partial });

    test("keeps its normal row, a link to the note, with a quiet informational line under it", () => {
      const html = recent();
      expect(html.match(/data-testid="recent-item"/g)).toHaveLength(1);
      expect(html).toContain('href="/chat/capture/library/row-1"');
      expect(html).toContain(">Voice note</b>");
      expect(html).toContain("Today 1:49 AM · 1:05");
      expect(html).toContain("<svg"); // the normal kind tile, not the "!" one
      expect(html).not.toContain("soft-tile-bang");
      expect(html).not.toContain("data-failed");
      expect(html).toContain('data-notice="true"');
      expect(html).toContain(
        'class="soft-row-notice" aria-label="Saved — part of this recording couldn&#x27;t be written. Opens details"',
      );
      expect(html).toContain(">Saved — part of this recording couldn&#x27;t be written</button>");
    });

    test("the row's accessible label includes the state, and is not marked as needing attention", () => {
      const html = recent();
      expect(html).toMatch(
        /aria-label="Voice note\. Today 1:49 AM · 1:05\. Saved — part of this recording couldn&#x27;t be written"/,
      );
      expect(html).not.toContain("Needs attention");
    });

    test("is not in the way of the other rows or the on-this-phone card", () => {
      const html = home({ inProgress: voice(2), recent: { status: "ready", items: [note(1), note(2)] } }, { "rec-1": partial });
      expect(html.match(/data-notice="true"/g)).toHaveLength(1);
      expect(html).not.toContain("Not in your space yet");
      expect(html).not.toContain("automatically");
    });

    test("a recording with no row yet shows no row of its own", () => {
      const html = home({}, { "rec-9": partial });
      expect(html).not.toContain("recent-item");
      expect(html).toContain("Your recordings appear here");
    });

    test("a real failure on the same recording wins: the failure row, no informational line", () => {
      const html = home(
        { recent: { status: "ready", items: [note(1)] } },
        { "rec-1": { kind: "write_failed", detail: "EIO" } },
      );
      expect(html).toContain('data-issue="write_failed"');
      expect(html).not.toContain("soft-row-notice");
      expect(html).not.toContain("Saved — part of");
    });

    test("the Library list marks the row the same way; with no notice there is no marker", () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <SoftHomeProvider enabled issues={{ "rec-1": partial }} onDismissIssue={() => true}>
            <LibraryListView status="ready" items={[note(1), note(2)]} filter="all" onFilterChange={noop} onRetry={noop} now={NOW} />
          </SoftHomeProvider>
        </MemoryRouter>,
      );
      expect(html.match(/class="soft-row-notice"/g)).toHaveLength(1);
      expect(home({ recent: { status: "ready", items: [note(1)] } })).not.toContain("soft-row-notice");
    });
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
  test("a local-only row names the recording device", () => {
    expect(libraryRowBadge(note(1, { metadata: { audio_stored: 0, audio_device_platform: "ios" } }))).toBe("Audio is on your iPhone");
  });
  const row = (provider: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        {provider ? (
          <SoftHomeProvider enabled issues={{}} onDismissIssue={() => true}>
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
        <SoftHomeProvider enabled={false} issues={{}} onDismissIssue={() => true}>
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
          <SoftHomeProvider enabled issues={issues} onDismissIssue={() => true}>
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
    expect(html.indexOf("rec-lost")).toBeLessThan(html.indexOf('data-source-id="rec-1"'));
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
