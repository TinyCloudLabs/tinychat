import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { Library } from "./useLibrary";
import type { LibraryItem } from "./LibraryRow";
import { NoteDetail } from "./NoteDetail";

const ITEM: LibraryItem = { id: "synthetic-row", source: "fireflies", sourceId: "synthetic-source", title: "Synthetic transcript", startedAt: null, durationSecs: null };
const TRANSCRIPT = { status: "ok" as const, sentences: [{ index: 0, text: "Synthetic conversation", speaker_name: "Speaker", start_time: 0, end_time: 0 }] };
const noop = () => {};

function render(item: LibraryItem, reads: Library["note"]["reads"]): string {
  const library = { status: "ready", listing: false, items: [item], all: [item], isCombinedMember: () => false,
    filter: "all", setFilter: noop, refresh: noop, retry: noop, note: { item, reads, audio: null } } as Library;
  // No SDK instance, signer or authority operation: SSR exercises the real caller → context → view.
  const tcw = { did: "did:example:synthetic", spaceId: "synthetic-space" } as TinyCloudWeb;
  return renderToStaticMarkup(<MemoryRouter><NoteDetail library={library} tcw={tcw} pushed={false} onBack={noop} transcription={undefined} /></MemoryRouter>);
}

const reads: Library["note"]["reads"] = { metadata: { status: "ok", metadata: {} }, transcript: { transcript: TRANSCRIPT, provenance: null } };

test("the real saved-transcript caller places the Share action beside Copy", () => {
  const html = render(ITEM, reads);
  const copy = html.indexOf('data-testid="note-copy"');
  const share = html.indexOf('data-testid="note-share-transcript"');
  expect(copy).toBeGreaterThan(-1);
  expect(share).toBeGreaterThan(copy);
  expect(html).not.toContain('role="dialog"');
});

test("device-only and still-saving notes never expose Share through the real caller", () => {
  expect(render({ ...ITEM, onPhone: true }, reads)).not.toContain('data-testid="note-share-transcript"');
  expect(render({ ...ITEM, saving: true }, reads)).not.toContain('data-testid="note-share-transcript"');
});

test("unreadable or absent persisted bodies and unsupported sources never expose Share", () => {
  expect(render(ITEM, { ...reads, transcript: { transcript: { status: "absent" }, provenance: null } })).not.toContain('data-testid="note-share-transcript"');
  expect(render(ITEM, { ...reads, metadata: { status: "failed" } })).not.toContain('data-testid="note-share-transcript"');
  expect(render({ ...ITEM, source: "foreign-app" }, reads)).not.toContain('data-testid="note-share-transcript"');
});
