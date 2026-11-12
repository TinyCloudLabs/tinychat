// The Library's "Audio only in this browser" filter, which the tinycloud.chat notice links to (OriginMoveNotice.tsx):
// reached by its address, it lists exactly the recordings originMove.ts holds for their audio, and clears.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";

import { NO_LOCAL_WORK, type LocalRecordingWork } from "@/lib/originMove";
import { LOCAL_AUDIO_LIBRARY_PATH, PATHS } from "@/shell/routes";
import { installDom } from "@/test/dom";
import { LibraryListView } from "./LibraryListView";
import type { LibraryItem } from "./LibraryRow";
import { LibraryScreen, LOCAL_AUDIO_FILTER_LABEL } from "./LibraryScreen";
import type { Library } from "./useLibrary";

const noop = () => {};
const NOW = new Date(2026, 9, 6, 9, 41);
const at = (day: number) => new Date(2026, 9, day, 9, 0).toISOString();
const voice = (n: number): LibraryItem =>
  ({ id: `row-${n}`, source: "exo-voice-note", sourceId: `rec-${n}`, title: `Voice note ${n}`, startedAt: at(n), durationSecs: 5 });
const LISTED: LibraryItem[] = [
  voice(1),
  voice(2),
  voice(3),
  // Another source whose id happens to match a held recording's is not that recording.
  { id: "row-ff", source: "fireflies", sourceId: "rec-1", title: "Weekly sync", startedAt: at(4), durationSecs: 60 },
];
// Combined into a meeting, so hidden from the list, yet its audio is still only here.
const HIDDEN = voice(5);
const library: Library = {
  status: "ready", items: LISTED, all: [...LISTED, HIDDEN], isCombinedMember: (item) => item.sourceId === HIDDEN.sourceId,
  listing: false, filter: "all", setFilter: noop, refresh: noop, retry: noop, note: { item: null, reads: {}, audio: null },
};
const HELD: LocalRecordingWork = { ...NO_LOCAL_WORK, signedIn: true, localAudio: ["rec-1", "rec-3", "rec-5"], unclaimed: 2, otherAccount: 1 };

describe("the Library's list with a named filter", () => {
  const render = (ids: ReadonlySet<string> | null) => renderToStaticMarkup(
    <MemoryRouter>
      <LibraryListView status="ready" items={[...LISTED, HIDDEN]} filter="all" onFilterChange={noop} onRetry={noop} now={NOW}
        only={{ label: LOCAL_AUDIO_FILTER_LABEL, empty: "None.", ids, onClear: noop }} />
    </MemoryRouter>,
  );
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href).sort();

  test("shows exactly the voice notes with those recording ids, under its name with a clear button, in place of the kind filter", () => {
    const html = render(new Set(["rec-1", "rec-5"]));
    expect(hrefs(html)).toEqual(["/chat/capture/library/row-1", "/chat/capture/library/row-5"]);
    expect(html).toContain(`>${LOCAL_AUDIO_FILTER_LABEL}<`);
    expect(html).toContain(`aria-label="Clear filter: ${LOCAL_AUDIO_FILTER_LABEL}"`);
    expect(html).not.toContain('role="radiogroup"');
  });

  test("waits while the ids are read, and says so when none are listed", () => {
    const loading = render(null);
    expect(loading).toContain("Loading your Library");
    expect(hrefs(loading)).toEqual([]);
    const empty = render(new Set(["rec-9"]));
    expect(empty).toContain('data-testid="library-empty"');
    expect(empty).toContain("None.");
  });
});

describe("the Library reached by the notice's address", () => {
  let restoreDom: () => void;
  let root: Root | null = null;
  let host: HTMLElement;
  let navigate: NavigateFunction;
  let location = { pathname: "", search: "" };

  beforeEach(() => { restoreDom = installDom(); });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    restoreDom();
  });

  function Probe() {
    navigate = useNavigate();
    location = useLocation();
    return null;
  }

  async function open(path: string, countLocalWork: () => Promise<LocalRecordingWork>) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <LibraryScreen library={library} pushed onBack={noop} selectedId={null} now={NOW} column="" countLocalWork={countLocalWork} />
      </MemoryRouter>,
    ));
  }
  const listed = () => [...host.querySelectorAll('[data-testid="library-list"] a[href]')].map((a) => a.getAttribute("href")).sort();
  const chip = () => host.querySelector('[data-testid="library-only-filter"]');

  test("lists exactly the recordings held for their audio, hidden members included, and stays on while one is open", async () => {
    expect(LOCAL_AUDIO_LIBRARY_PATH).toBe("/chat/capture/library?show=local-audio");
    const read = Promise.withResolvers<LocalRecordingWork>();
    await open(LOCAL_AUDIO_LIBRARY_PATH, () => read.promise);
    expect(chip()?.textContent).toContain(LOCAL_AUDIO_FILTER_LABEL);
    expect(listed()).toEqual([]);
    await act(async () => read.resolve(HELD));
    expect(listed()).toEqual(["/chat/capture/library/row-1", "/chat/capture/library/row-3", "/chat/capture/library/row-5"]);

    // Opening one leaves the address; the filter stays for the next one.
    await act(async () => navigate("/chat/capture/library/row-1"));
    expect(chip()).not.toBeNull();
    expect(listed()).toEqual(["/chat/capture/library/row-1", "/chat/capture/library/row-3", "/chat/capture/library/row-5"]);
  });

  test("clearing it drops it from the address and brings the kind filter and every listed row back", async () => {
    await open(LOCAL_AUDIO_LIBRARY_PATH, async () => HELD);
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="Clear filter: ${LOCAL_AUDIO_FILTER_LABEL}"]`)!.click());
    expect(location).toMatchObject({ pathname: PATHS.library, search: "" });
    expect(chip()).toBeNull();
    expect(host.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(listed()).toEqual(["/chat/capture/library/row-1", "/chat/capture/library/row-2", "/chat/capture/library/row-3", "/chat/capture/library/row-ff"]);
  });

  test("with nothing held for its audio, it says so", async () => {
    await open(LOCAL_AUDIO_LIBRARY_PATH, async () => ({ ...HELD, localAudio: [] }));
    expect(listed()).toEqual([]);
    expect(host.querySelector('[data-testid="library-empty"]')?.textContent).toBe("No recordings have audio only in this browser.");
  });

  test("the plain Library address shows no filter and reads nothing", async () => {
    let reads = 0;
    await open(PATHS.library, async () => { reads++; return HELD; });
    expect(chip()).toBeNull();
    expect(reads).toBe(0);
    expect(listed()).toHaveLength(4);
  });
});
