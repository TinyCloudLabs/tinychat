// The Library's row (P1-8): a voice note is titled by its own words, "Voice note" without any, and its line is
// "7:16 PM · 0:14" inside a day (with "Today" outside one), so notes minutes apart tell apart; a note not yet in the
// space says "On this browser" or "Saving…". The same on the phone's Soft rows and the plain list.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { SoftHomeProvider } from "../home/softHome";
import { LibraryRow, libraryRowAsideDuration, libraryRowBadge, libraryRowMeta, libraryRowTitle, type LibraryItem } from "./LibraryRow";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";

const NOW = new Date(2026, 9, 10, 19, 30);
const voice = (patch: Partial<LibraryItem> = {}): LibraryItem => ({
  id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note · Oct 10, 7:16 PM",
  startedAt: new Date(2026, 9, 10, 19, 16).toISOString(), durationSecs: 14, ...patch,
});
const meeting: LibraryItem = {
  id: "row-2", source: "fireflies", sourceId: "mtg-2", title: "Weekly sync", startedAt: new Date(2026, 9, 10, 14, 0).toISOString(), durationSecs: 1880,
};

function render(item: LibraryItem, options: { grouped?: boolean; soft?: boolean; pipeline?: NotePipeline } = {}) {
  const row = <LibraryRow item={item} now={NOW} grouped={options.grouped ?? false} pipeline={options.pipeline} />;
  return renderToStaticMarkup(
    <MemoryRouter>
      {options.soft === false ? <ul>{row}</ul> : <SoftHomeProvider enabled issues={{}} onDismissIssue={() => true}>{row}</SoftHomeProvider>}
    </MemoryRouter>,
  );
}

describe("a voice note's row", () => {
  test("is titled by its first words, else Voice note, never by its date", () => {
    expect(libraryRowTitle(voice({ snippet: "Call the landlord" }))).toBe("Call the landlord");
    expect(libraryRowTitle(voice())).toBe("Voice note");
    expect(libraryRowTitle(voice({ title: null }))).toBe("Voice note");
    expect(libraryRowTitle(meeting)).toBe("Weekly sync");
  });

  test("says the time and the length, in a day's group and out of one", () => {
    expect(libraryRowMeta(voice(), NOW, true)).toBe("7:16 PM · 0:14");
    expect(libraryRowMeta(voice(), NOW, false)).toBe("Today 7:16 PM · 0:14");
    expect(libraryRowMeta(voice({ durationSecs: null }), NOW, true)).toBe("7:16 PM");
    expect(libraryRowMeta(meeting, NOW, true)).toBe("Fireflies · 2:00 PM");
  });

  test("keeps its length in its line, not beside the chevron; other kinds keep theirs there", () => {
    expect(libraryRowAsideDuration(voice(), false)).toBeNull();
    expect(libraryRowAsideDuration(voice(), true)).toBe(14);
    expect(libraryRowAsideDuration(meeting, false)).toBe(1880);
  });

  test("two notes minutes apart read differently on a Soft row", () => {
    const a = render(voice({ snippet: "Call the landlord" }), { grouped: true });
    const b = render(voice({ id: "row-3", sourceId: "rec-3", startedAt: new Date(2026, 9, 10, 19, 21).toISOString(), durationSecs: 61 }), { grouped: true });
    expect(a).toContain(">Call the landlord</b>");
    expect(a).toContain(">7:16 PM · 0:14<");
    expect(b).toContain(">Voice note</b>");
    expect(b).toContain(">7:21 PM · 1:01<");
    expect(a).toContain('aria-label="Call the landlord. 7:16 PM · 0:14"');
    expect(a).not.toContain("Oct 10");
  });

  test("reads the same on the plain list", () => {
    const html = render(voice({ snippet: "Call the landlord" }), { grouped: true, soft: false });
    expect(html).toContain("Call the landlord");
    expect(html).toContain("7:16 PM · 0:14");
    expect(html).not.toContain("Oct 10");
    expect(html).not.toContain('<span class="tnum">0:14</span>');
  });
});

describe("a note not yet settled in the space", () => {
  test("says where a local note is without a stale Saving badge", () => {
    expect(libraryRowBadge(voice({ onPhone: true }))).toBe("On this browser");
    expect(libraryRowBadge(voice({ onPhone: true }), "on this Mac")).toBe("On this Mac");
    expect(libraryRowBadge(voice({ onPhone: true }), "in this browser")).toBe("In this browser");
    expect(libraryRowBadge(voice({ saving: true }))).toBeNull();
    expect(libraryRowBadge(voice())).toBeNull();
    expect(libraryRowBadge(meeting)).toBeNull();
  });

  test("shows track statuses on Soft rows and keeps the old badge in the plain list", () => {
    const onPhone = voice({ id: "on-phone:rec-1", onPhone: true, title: null });
    const active: NotePipeline = { steps: [
      { key: "phone", label: "On this browser", state: "done" },
      { key: "space", label: "In your space", state: "waiting", caption: "Waiting to upload" },
      { key: "transcript", label: "Transcript", state: "upcoming" },
      { key: "notes", label: "Notes", state: "skipped" },
    ], current: "space", done: false };
    const html = render(onPhone, { pipeline: active });
    expect(html).not.toContain('data-pipeline-halo=""');
    expect(html).toContain("Audio in your space: Waiting to upload");
    expect(html).toContain('data-pipeline-track-summary=""');
    expect(html).toContain("Audio: Waiting to upload");
    expect(html).not.toContain("row-badge");
    const done: NotePipeline = { steps: [
      { key: "phone", label: "On this browser", state: "done" },
      { key: "space", label: "In your space", state: "done" },
      { key: "transcript", label: "Transcript", state: "skipped" },
      { key: "notes", label: "Notes", state: "skipped" },
    ], current: null, done: true };
    expect(render(voice(), { pipeline: done })).not.toContain("data-pipeline-track-summary");
    expect(render(onPhone, { soft: false })).toContain('data-testid="row-badge"');
    expect(render(voice({ saving: true }))).not.toContain("Saving…");
    expect(render(voice())).not.toContain("row-badge");
  });
});
