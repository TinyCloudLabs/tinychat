// Capture's home (TC-761): first use, In progress, and Recent capped at five.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { CaptureHomeView, type CaptureHomeViewProps } from "./CaptureHomeView";
import type { InProgressRowsViewProps } from "./InProgressRows";
import type { LibraryItem } from "./library/LibraryRow";

const noop = () => {};
const NOW = new Date(2026, 9, 6, 9, 41);
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
const item = (i: number): LibraryItem => ({
  id: `row-${i}`,
  source: "exo-voice-note",
  sourceId: `rec-${i}`,
  title: `Voice note · ${i}`,
  startedAt: new Date(2026, 9, 6, 9, 30 - i).toISOString(),
  durationSecs: 42,
});

function render(patch: Partial<CaptureHomeViewProps> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CaptureHomeView platform="ios" inProgress={idle} recent={{ status: "ready", items: [] }} onRetryRecent={noop} now={NOW} {...patch} />
    </MemoryRouter>,
  );
}

describe("CaptureHomeView", () => {
  test("first use: the display headline and one short line; no Recent", () => {
    const html = render();
    expect(html).toContain('data-testid="capture-first-use"');
    expect(html).toContain("Think out loud.");
    expect(html).toContain("font-display text-display");
    expect(html).not.toContain('data-testid="capture-recent"');
    // Where nothing records, it invites the other two.
    expect(render({ platform: "web" })).toContain("Bring in a conversation.");
  });

  test("in progress: the rows show, and first use stays away", () => {
    const html = render({ inProgress: { ...idle, paused: { fileName: "Interview.m4a" } } });
    expect(html).toContain('data-testid="in-progress"');
    expect(html).toContain("Interview.m4a");
    expect(html).not.toContain("Think out loud.");
  });

  test("a phone listing that failed is In progress (its recovery row), never first use", () => {
    const html = render({
      inProgress: {
        ...idle,
        voice: { listing: { state: "error", message: "no bridge" }, saving: false, lastError: null, limitNotice: null, onSaveNow: noop },
      },
    });
    expect(html).toContain('data-testid="voice-note-list-failed"');
    expect(html).not.toContain("Think out loud.");
    // Not asked yet is not something in progress.
    const unknown = render({
      inProgress: { ...idle, voice: { listing: { state: "unknown" }, saving: false, lastError: null, limitNotice: null, onSaveNow: noop } },
    });
    expect(unknown).toContain("Think out loud.");
  });

  test("Recent: the newest five, with See all to the Library", () => {
    const html = render({ recent: { status: "ready", items: Array.from({ length: 8 }, (_, i) => item(i)) } });
    expect(html).toContain(">Recent</h2>");
    expect(html).toContain('href="/chat/capture/library"');
    expect(html.match(/data-testid="recent-item"/g)).toHaveLength(5);
    expect(html).toContain('href="/chat/capture/library/row-0"');
    expect(html).not.toContain("row-5");
    expect(html).toContain(">0:42<");
    expect(html).not.toContain("Think out loud.");
  });

  test("loading shows skeleton rows, never first use; a failed list offers Try again; wide leaves Recent out", () => {
    const loading = render({ recent: { status: "loading", items: [] } });
    expect(loading).toContain('data-skeleton="row"');
    expect(loading).not.toContain("Think out loud.");
    expect(render({ recent: { status: "failed", items: [] } })).toContain("Try again");
    const wide = render({ recent: null });
    expect(wide).not.toContain('data-testid="capture-recent"');
    expect(wide).not.toContain("Think out loud.");
  });
});
