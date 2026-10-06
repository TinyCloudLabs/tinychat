// The Library's list (TC-761; moved from MeetingsPage.test.tsx): loading,
// failed with Try again (never "nothing here"), empty and filtered, and rows
// under their day with a tabular duration. And the Library keeps BOTH meeting
// data paths (from connectorsNav.test.tsx).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { LibraryListView, type LibraryListViewProps } from "./LibraryListView";
import type { LibraryItem } from "./LibraryRow";
import { LibraryScreen } from "./LibraryScreen";
import type { Library } from "./useLibrary";

const noop = () => {};
const NOW = new Date(2026, 9, 6, 9, 41);
const ITEMS: LibraryItem[] = [
  { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note · Oct 6, 9:28 AM", startedAt: new Date(2026, 9, 6, 9, 28).toISOString(), durationSecs: 42 },
  { id: "row-2", source: "fireflies", sourceId: "ff-2", title: "Weekly sync", startedAt: new Date(2026, 9, 5, 14, 0).toISOString(), durationSecs: 1880 },
  { id: "row-3", source: "exo-upload", sourceId: "up-3", title: "Interview", startedAt: new Date(2026, 9, 1, 11, 0).toISOString(), durationSecs: null },
];

function render(patch: Partial<LibraryListViewProps> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LibraryListView status="ready" items={ITEMS} filter="all" onFilterChange={noop} onRetry={noop} now={NOW} {...patch} />
    </MemoryRouter>,
  );
}

describe("LibraryListView", () => {
  test("loading: skeleton rows and a status for assistive tech", () => {
    const html = render({ status: "loading", items: [] });
    expect(html).toContain('data-state="loading"');
    expect(html.match(/data-skeleton="row"/g)).toHaveLength(5);
    expect(html).toContain("Loading your Library…");
  });

  test("a list that did not load says so and offers Try again, never an empty Library", () => {
    const html = render({ status: "failed", items: [] });
    expect(html).toContain("Couldn’t load your Library.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Nothing here yet.");
  });

  test("a refresh that fails keeps the rows and offers Try again", () => {
    const html = render({ status: "failed" });
    expect(html).toContain("Couldn’t refresh the Library.");
    expect(html).toContain('data-testid="voice-note-item"');
  });

  test("rows under their day: kind, title, where from, and a tabular duration", () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html.indexOf(">Today<")).toBeLessThan(html.indexOf(">Yesterday<"));
    expect(html).toContain('data-testid="voice-note-item" data-source-id="rec-1"');
    expect(html).toContain('href="/chat/capture/library/row-1"');
    expect(html).toContain('<span class="tnum">0:42</span>');
    expect(html).toContain('<span class="tnum">31:20</span>');
    expect(html).toContain("Fireflies · ");
  });

  test("a filter keeps its kind, and an empty one says what it holds", () => {
    const notes = render({ filter: "note" });
    expect(notes).toContain("rec-1");
    expect(notes).not.toContain("Weekly sync");
    expect(render({ filter: "upload", items: ITEMS.slice(0, 2) })).toContain("No uploads yet.");
    expect(render({ items: [] })).toContain("Nothing here yet.");
  });

  test("the open note is the selected row", () => {
    expect(render({ selectedId: "row-2" })).toContain('aria-current="page"');
  });
});

describe("the Library keeps BOTH meeting data paths", () => {
  test("LibraryScreen renders the list and the cohort slot; the list reads the user's own space", () => {
    const library: Library = {
      status: "ready",
      items: ITEMS,
      filter: "all",
      setFilter: noop,
      refresh: noop,
      retry: noop,
      note: { item: null, reads: {}, loadAudio: null },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryScreen library={library} meetingsSlot={<p>cohort-meetings</p>} pushed onBack={noop} selectedId={null} now={NOW} column="" />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="library-list"');
    expect(html).toContain("cohort-meetings");
    const source = readFileSync(join(import.meta.dir, "useLibrary.ts"), "utf8");
    expect(source).toContain("listMeetingsRead(space)");
  });
});
