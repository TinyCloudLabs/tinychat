// The desktop Capture home: the markup of each state, rendered statically.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext, type AppPlatform } from "@/lib/platform";
import type { InProgressRowsViewProps } from "../../InProgressRows";
import type { RecorderCaptureIssue } from "../../recorder/recorderReducer";
import type { LibraryItem } from "../../library/LibraryRow";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../../recorder/RecorderProvider";
import { registerDesktopWhisperQueue, type DesktopWhisperJob, type DesktopWhisperQueue } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { retryWhisperJob } from "@/capture/library/DesktopWhisperStatus";
import { dismissNotice } from "../captureIssues";
import { HOME_COPY } from "../homeCopy";
import {
  DesktopCaptureHome,
  DismissControl,
  FilterChips,
  RecentRow,
  WhisperRetryControl,
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

  test("a Dismiss that is not saved (false, or a throw) is the phone sheet's inline alert beside the button, which stays", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcomes = [
        dismissNotice("rec-1", () => false),
        dismissNotice("rec-1", () => {
          throw new Error("native: storage unavailable");
        }),
      ];
      expect(outcomes).toEqual([HOME_COPY.dismissFailed, HOME_COPY.dismissFailed]);
      expect(error).toHaveBeenCalledTimes(2);
      for (const outcome of outcomes) {
        const html = renderToStaticMarkup(
          <DismissControl label="Dismiss the notice for X" error={outcome} onDismiss={noop} />,
        );
        expect(html).toContain('role="alert"');
        expect(html).toContain('data-testid="capture-issue-error"');
        expect(html).toContain(HOME_COPY.dismissFailed.replace("'", "&#x27;"));
        expect(html).toContain('data-testid="capture-issue-dismiss"');
        const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
        expect(id).toBeDefined();
        expect(html).toContain(`id="${id}"`);
      }
    } finally {
      error.mockRestore();
    }
  });

  test("a Dismiss with nothing to report shows no alert", () => {
    const html = renderToStaticMarkup(
      <DismissControl label="Dismiss the notice for X" error={null} onDismiss={noop} />,
    );
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain('data-testid="capture-issue-dismiss"');
  });

  test("loading and failed keep their own states", () => {
    expect(home({ props: { recent: { status: "loading", items: [] } } })).toContain("Loading your recent captures…");
    const failed = home({ props: { recent: { status: "failed", items: [] } } });
    expect(failed).toContain("Couldn’t load your recent captures.");
    expect(failed).not.toContain("Your recordings appear here");
  });
});

describe("failed recordings", () => {
  const lost: RecorderCaptureIssue = { kind: "recoveryFailed", detail: "ENOSPC /var/x" };
  const rowsOf = (html: string) => html.split("<li ").slice(1);

  test("a recording with no Library row yet is one button that opens its sheet, with the issue in its label", () => {
    const html = home({ recorder: { captureIssues: { orphan: lost } } });
    const row = rowsOf(html).find((li) => li.includes('data-source-id="orphan"'))!;
    expect(row).toMatch(/<button type="button" class="soft-row"/);
    expect(row).toContain("Couldn&#x27;t recover this recording. Needs attention. Opens details");
    expect(row).not.toContain("<a ");
    expect(row).not.toContain("ENOSPC");
  });

  test("a Library voice note whose recording failed is a button too, not a link to its note", () => {
    const html = home({
      recorder: { captureIssues: { "rec-1": lost } },
      props: { recent: { status: "ready", items: [note(1), note(2)] } },
    });
    const failed = rowsOf(html).find((li) => li.includes('data-source-id="rec-1"'))!;
    expect(failed).toMatch(/<button type="button" class="soft-row"/);
    expect(failed).not.toContain('href="/chat/capture/library/row-1"');
    const fine = rowsOf(html).find((li) => li.includes('data-source-id="rec-2"'))!;
    expect(fine).toContain('href="/chat/capture/library/row-2"');
  });

  test("a write failure opens its sheet; a parked recording is a row with its audio kept", () => {
    const html = home({ recorder: { captureIssues: { w: { kind: "write_failed", detail: "x" } } } });
    expect(rowsOf(html).find((li) => li.includes('data-source-id="w"'))).toMatch(/<button /);
    const parked = renderToStaticMarkup(
      <MemoryRouter>
        <ul>
          <RecentRow
            entry={{ type: "issue", id: "p", issue: { kind: "quarantined" } }}
            now={NOW}
            grouped={false}
            onDismiss={() => true}
            onOpenIssue={noop}
          />
        </ul>
      </MemoryRouter>,
    );
    expect(parked).toContain("Couldn&#x27;t recover this recording · audio kept");
    expect(parked).toMatch(/<button /);
  });

  test("a timed-out save stays the saving row, and partial audio keeps Dismiss: neither opens a sheet", () => {
    const html = home({
      recorder: {
        captureIssues: { saving: { kind: "finalization_timed_out" }, "rec-1": { kind: "partial_audio" } },
      },
      props: { recent: { status: "ready", items: [note(1)] } },
    });
    const saving = rowsOf(html).find((li) => li.includes('data-source-id="saving"'))!;
    expect(saving).toContain("Saving… · kept on this Mac");
    expect(saving).toContain('role="group"');
    expect(saving).not.toMatch(/<button /);
    expect(saving).not.toContain("Needs attention");
    const partial = rowsOf(html).find((li) => li.includes('data-source-id="rec-1"'))!;
    expect(partial).toContain('data-testid="capture-issue-dismiss"');
    expect(partial).not.toContain("Opens details");
  });

  test("Recent is where focus lands when a failed row goes: its heading is focusable and marked", () => {
    const html = home();
    expect(html).toMatch(/<section[^>]*data-return-focus=""[^>]*data-testid="capture-recent"/);
    expect(html).toMatch(/<h2 id="dch-recent-title"[^>]*tabindex="-1"[^>]*data-return-focus-target=""/);
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
            onDismiss={() => true}
            onOpenIssue={noop}
          />
        </ul>
      </MemoryRouter>,
    );
    expect(html).toContain('data-source-id="rec-3"');
  });
});

describe("a row with an after-stop Whisper job", () => {
  afterEach(() => registerDesktopWhisperQueue(null));
  const rowFor = (job: DesktopWhisperJob | null, entry = { type: "item" as const, item: note(3), startedAt: note(3).startedAt }) => {
    const jobs = new Map(job ? [[job.id, job]] : []);
    registerDesktopWhisperQueue({ snapshot: () => jobs, subscribe: () => noop } as unknown as DesktopWhisperQueue);
    return renderToStaticMarkup(
      <MemoryRouter>
        <ul>
          <RecentRow entry={entry} now={NOW} grouped onDismiss={() => true} onOpenIssue={noop} />
        </ul>
      </MemoryRouter>,
    );
  };
  const job = (patch: Partial<DesktopWhisperJob>): DesktopWhisperJob => ({ id: "rec-3", state: "queued", error: null, progress: null, ...patch });

  test("shows waiting, progress and a failure in the meta line, and links to the note", () => {
    expect(rowFor(job({ state: "queued" }))).toContain("Waiting to transcribe on this Mac");
    expect(rowFor(job({ state: "transcribing", progress: 61 }))).toContain("Transcribing on this Mac · 61%");
    const failed = rowFor(job({ state: "failed", error: "raw detail" }));
    expect(failed).toContain("Couldn’t transcribe on this Mac");
    expect(failed).toContain('data-failed="true"');
    expect(failed).not.toContain("raw detail");
    expect(failed).toContain('href="/chat/capture/library/row-3"');
  });

  test("a finished job, another note's job, or no queue leaves the row as it was", () => {
    const plain = rowFor(null);
    expect(rowFor(job({ state: "done" }))).toBe(plain);
    expect(rowFor(job({ id: "other", state: "failed" }))).toBe(plain);
    registerDesktopWhisperQueue(null);
    expect(renderToStaticMarkup(
      <MemoryRouter><ul><RecentRow entry={{ type: "item", item: note(3), startedAt: note(3).startedAt }} now={NOW} grouped onDismiss={() => true} onOpenIssue={noop} /></ul></MemoryRouter>,
    )).toBe(plain);
  });

  test("a failed job gets a Retry button beside the row link, not inside it; other states and rows get none", () => {
    const failed = rowFor(job({ state: "failed", error: "raw detail" }));
    expect(failed).toContain('data-testid="recent-whisper-retry"');
    expect(failed).toContain('aria-label="Retry transcribing Voice note · Oct 9, 1:47 AM on this Mac"');
    expect(failed).not.toContain('role="alert"');
    const link = failed.match(/<a [^>]*>[\s\S]*?<\/a>/)![0];
    expect(link).not.toContain("Retry");
    expect(failed.indexOf("recent-whisper-retry")).toBeGreaterThan(failed.indexOf("</a>"));
    expect(rowFor(job({ state: "queued" }))).not.toContain("recent-whisper-retry");
    expect(rowFor(job({ state: "transcribing", progress: 5 }))).not.toContain("recent-whisper-retry");
    expect(rowFor(job({ state: "done" }))).not.toContain("recent-whisper-retry");
    expect(rowFor(job({ id: "other", state: "failed" }))).not.toContain("recent-whisper-retry");
    expect(rowFor(job({ state: "failed" }), {
      type: "item", item: note(3), startedAt: note(3).startedAt, issue: { kind: "write_failed", detail: "x" },
    } as never)).not.toContain("recent-whisper-retry");
  });

  test("the Retry control: a failed retry shows a generic alert, never the raw job error", () => {
    const control = (error: boolean) =>
      renderToStaticMarkup(<WhisperRetryControl label="Retry it" error={error} onRetry={noop} />);
    expect(control(false)).not.toContain('role="alert"');
    const failed = control(true);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Couldn’t start the retry. Try again.");
    expect(failed).toContain("aria-describedby");
    expect(rowFor(job({ state: "failed", error: "raw detail" }))).not.toContain("raw detail");
  });

  test("Retry calls the queue's retry for that note, and a refusal reaches the alert path", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const retries: string[] = [];
    let refuse = false;
    registerDesktopWhisperQueue({
      snapshot: () => new Map(),
      subscribe: () => noop,
      retry: async (id: string) => { retries.push(id); if (refuse) throw new Error("raw detail"); },
    } as unknown as DesktopWhisperQueue);
    const failures: string[] = [];
    retryWhisperJob("rec-3", () => failures.push("x"));
    await Bun.sleep(0);
    expect(retries).toEqual(["rec-3"]);
    expect(failures).toEqual([]);
    refuse = true;
    retryWhisperJob("rec-3", () => failures.push("x"));
    await Bun.sleep(0);
    expect(failures).toEqual(["x"]);
    error.mockRestore();
  });

  test("a recording failure keeps its own row, whatever the job says", () => {
    const html = rowFor(job({ state: "transcribing", progress: 5 }), {
      type: "item", item: note(3), startedAt: note(3).startedAt, issue: { kind: "write_failed", detail: "x" },
    } as never);
    expect(html).not.toContain("Transcribing on this Mac");
  });
});
