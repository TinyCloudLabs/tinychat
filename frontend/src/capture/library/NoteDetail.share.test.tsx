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

function ownerClient(overrides: Partial<TinyCloudWeb> = {}): TinyCloudWeb {
  // Inert session-shaped data only: no SDK instance, signer, identity or authority operation.
  return {
    session: () => ({ address: "0x0000000000000000000000000000000000000001", walletAddress: "0x0000000000000000000000000000000000000001",
      chainId: 1, sessionKey: "inert-session", siwe: "", signature: "" }),
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
    sessionDid: "did:example:synthetic-session", credentialHolderDid: "did:example:synthetic-session",
    credentialSpaceOwnerDid: () => "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    sessionRestoreStatus: "idle", isSessionOnly: false, isWalletConnected: true,
    hasPermissions: () => true,
    ...overrides,
  } as unknown as TinyCloudWeb;
}

function render(item: LibraryItem, reads: Library["note"]["reads"], tcw: TinyCloudWeb = ownerClient()): string {
  const library = { status: "ready", listing: false, items: [item], all: [item], isCombinedMember: () => false,
    filter: "all", setFilter: noop, refresh: noop, retry: noop, note: { item, reads, audio: null } } as Library;
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

test("a caller with no session is not offered Share", () => {
  expect(render(ITEM, reads, ownerClient({ session: () => undefined }))).not.toContain('data-testid="note-share-transcript"');
});

test("a caller in another owner's space is not offered Share", () => {
  const foreign = ownerClient({
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:applications",
    credentialSpaceOwnerDid: () => "did:pkh:eip155:1:0x0000000000000000000000000000000000000002",
  });
  expect(render(ITEM, reads, foreign)).not.toContain('data-testid="note-share-transcript"');
});

test("a caller missing the existing KV put grant is not offered Share", () => {
  const missingKv = ownerClient({
    hasPermissions: (entries) => !entries.some((entry) => entry.service === "tinycloud.kv" && entry.actions.includes("put")),
  });
  expect(render(ITEM, reads, missingKv)).not.toContain('data-testid="note-share-transcript"');
});

for (const [route, state] of [
  ["restored", { sessionRestoreStatus: "restored" as const }],
  ["session-only", { isSessionOnly: true }],
  ["disconnected wallet", { isWalletConnected: false }],
] as const) {
  test(`an otherwise eligible ${route} owner sees a non-executable sign-in prompt`, () => {
    const html = render(ITEM, reads, ownerClient(state));
    const action = html.match(/<button\b[^>]*data-testid="note-share-transcript"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(action).toBeDefined();
    expect(action).toMatch(/\bdisabled(?:=|[\s>])/);
    expect(action).toContain("Sign in again to share");
    expect(html).not.toContain('role="dialog"');
  });
}
