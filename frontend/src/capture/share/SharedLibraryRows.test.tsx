// TC-3195: the Library's "Shared with me" filter lists recordings other people shared with this account, and none
// of the account's own rows; the chip shows in the signed-in Library only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { parseRecordingDisplay } from "@/lib/nativeShares/display";
import { parseReceivedShare, sharedNoteId, type ReceivedRecordingShare } from "@/lib/nativeShares/receivedShares";
import type { RecordStoreSnapshot } from "@/lib/nativeShares/spaceRecords";
import { notePath } from "@/shell/routes";
import { LibraryListView, type LibraryListViewProps } from "../library/LibraryListView";
import type { LibraryItem } from "../library/LibraryRow";
import { LIBRARY_FILTERS, SHARED_FILTER, emptyFilterText, matchesFilter } from "../library/libraryKinds";

const noop = () => {};
const NOW = new Date(2026, 10, 17, 10, 0);
const OWNER = { address: "0xd5590000000000000000000000000000000ff412", chainId: 1, spaceId: "tinycloud:pkh:eip155:1:0xd5590000000000000000000000000000000ff412:default" };
const OWN: LibraryItem[] = [
  { id: "own-1", source: "fireflies", sourceId: "ff-1", title: "Hiring loop debrief", startedAt: new Date(2026, 10, 16, 11, 30).toISOString(), durationSecs: 1491 },
];

function share(id: string, title: string, recordedAt: Date, patch: Partial<ReceivedRecordingShare> = {}): ReceivedRecordingShare {
  const display = parseRecordingDisplay({ title, recordedAt: recordedAt.toISOString(), durationSeconds: 1924, includes: ["transcript", "audio"], source: "meeting" })!;
  return { version: 1, id, display, owner: OWNER, delegation: "{}", paths: ["t", "a/"], claimedAt: NOW.toISOString(), accessExpiresAt: new Date(2027, 10, 17).toISOString(), ...patch };
}

function render(patch: Partial<LibraryListViewProps> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LibraryListView status="ready" items={OWN} filter="shared" onFilterChange={noop} onRetry={noop} now={NOW} {...patch} />
    </MemoryRouter>,
  );
}

const ready = (records: ReceivedRecordingShare[]): RecordStoreSnapshot<ReceivedRecordingShare> => ({ state: "ready", records });

describe("Shared with me", () => {
  test("the chip follows the kinds, in the signed-in Library only", () => {
    expect(LIBRARY_FILTERS.map((filter) => filter.value)).not.toContain("shared");
    expect(SHARED_FILTER).toEqual({ value: "shared", label: "Shared with me" });
    expect(render({ filter: "all", shared: ready([]) })).toContain("Shared with me");
    expect(render({ filter: "all" })).not.toContain("Shared with me");
  });

  test("no own row is under it", () => {
    for (const source of ["fireflies", "exo-voice-note", "exo-upload", "exo-merged"]) expect(matchesFilter(source, "shared")).toBe(false);
    const html = render({ shared: ready([share("bafy-a", "Product sync with Priya", new Date(2026, 10, 16, 14, 0))]) });
    expect(html).not.toContain("Hiring loop debrief");
    expect(html).not.toContain('data-testid="library-item"');
  });

  test("lists each shared recording under the day it was added, newest first, never the link's recorded date", () => {
    const html = render({
      shared: ready([
        share("bafy-new", "Product sync with Priya", new Date(2026, 10, 16, 14, 0), { claimedAt: new Date(2026, 10, 10, 9, 0).toISOString() }),
        share("bafy-old", "Customer call: Northwind", new Date(2026, 9, 28, 15, 0), { claimedAt: new Date(2026, 10, 16, 9, 0).toISOString(), revokedAt: new Date(2026, 10, 17).toISOString() }),
      ]),
      selectedId: sharedNoteId("bafy-new"),
    });
    expect(html.match(/data-testid="shared-item"/g)?.length).toBe(2);
    expect(html.indexOf(">Yesterday<")).toBeLessThan(html.indexOf("Customer call: Northwind"));
    expect(html.indexOf("Customer call: Northwind")).toBeLessThan(html.indexOf(">Nov 10<"));
    expect(html.indexOf(">Nov 10<")).toBeLessThan(html.indexOf("Product sync with Priya"));
    expect(html).not.toContain(">Oct 28<");
    expect(html).toContain(`href="${notePath(sharedNoteId("bafy-new"))}"`);
    expect(html).toContain("From 0xd559…f412<");
    expect(html).toContain("From 0xd559…f412 · No\u00a0longer\u00a0shared<");
    expect(html.match(/>Title and length from the link</g)?.length).toBe(2);
    expect(html).toContain("32:04");
  });

  test("a name in a stored display is unsigned: the row names the verified owner's address", () => {
    const stored = share("bafy-named", "Board minutes", new Date(2026, 10, 16, 14, 0));
    const read = parseReceivedShare({ ...stored, display: { ...stored.display, senderName: "Sam Lee" } })!;
    const html = render({ shared: ready([read]) });
    expect(html).toContain("From 0xd559…f412");
    expect(html).not.toContain("Sam Lee");
  });

  test("empty, loading and failed", () => {
    expect(render({ shared: ready([]) })).toContain(emptyFilterText("shared"));
    expect(render({ shared: { state: "loading", records: [] } })).toContain("Loading your Library…");
    expect(render({ shared: { state: "failed", records: [] } })).toContain("Couldn’t load your Library.");
  });
});
