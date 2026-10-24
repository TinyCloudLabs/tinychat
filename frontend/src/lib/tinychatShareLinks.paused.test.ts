import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_SHARING_PAUSED, ChatSharingPausedError, canOfferChatShare } from "./chatSharing";
import { deleteThread } from "./threadStore";
import { shareIndexKeyFor, snapshotKeyFor } from "./shareRecords";

const originalWindow = globalThis.window;
const originalHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;
const originalCustomElements = (globalThis as { customElements?: unknown }).customElements;

type ShareModule = typeof import("./tinychatShareLinks");

async function loadShareModule(): Promise<ShareModule> {
  (globalThis as { HTMLElement?: unknown }).HTMLElement ??= class HTMLElement {};
  (globalThis as { customElements?: unknown }).customElements ??= {
    define: () => {},
    get: () => undefined,
  };
  return import("./tinychatShareLinks");
}

function installStorage() {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  (globalThis as { window?: unknown }).window = { localStorage };
  return storage;
}

function token(expiresAt: string, id = "share-1"): string {
  const payload = {
    format: "tinychat.share",
    version: 1,
    id,
    threadId: "thread-1",
    title: "Shared chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt,
    sql: {
      host: "https://node.example",
      spaceId: "space",
      keyDid: "did:key:z6MkKey#key-1",
      key: { kty: "OKP" },
      delegation: { cid: "bafydelegation" },
    },
  };
  return `tcchat1:${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = originalHTMLElement;
  (globalThis as { customElements?: unknown }).customElements = originalCustomElements;
});

const LIVE = "11111111-1111-4111-8111-111111111111";
const LAPSED = "22222222-2222-4222-8222-222222222222";
const MINE = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

function seedShare(kv: Map<string, string>, shareId: string, threadId: string, expiresAt: string) {
  kv.set(snapshotKeyFor(shareId), "{}");
  kv.set(
    shareIndexKeyFor(shareId),
    JSON.stringify({
      shareId,
      threadId,
      title: `Chat ${threadId}`,
      key: snapshotKeyFor(shareId),
      cid: `cid-${shareId}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt,
    }),
  );
}

// In-memory owner space: KV map, a thread database that accepts deletes, and a delegation-revoke log.
function fakeOwnerTcw(options: { failRevoke?: boolean } = {}) {
  const kv = new Map<string, string>();
  const revoked: string[] = [];
  const deleteWaiters: Record<string, () => void> = {};
  const db = {
    batch: async () => ({ ok: true, data: { rows: [] } }),
    query: async () => ({ ok: true, data: { rows: [] } }),
  };
  const tcw = {
    did: "did:pkh:eip155:1:paused",
    sql: { db: () => db },
    kv: {
      get: async (key: string) =>
        kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { message: "not found" } },
      delete: async (key: string) => {
        kv.delete(key);
        deleteWaiters[key]?.();
        return { ok: true, data: {} };
      },
      list: async ({ path }: { path: string }) => ({
        ok: true,
        data: { keys: [...kv.keys()].filter((key) => key.startsWith(path)) },
      }),
    },
    revokeDelegation: async (cid: string) => {
      if (options.failRevoke) return { ok: false, error: { message: "Controlled revoke failure" } };
      revoked.push(cid);
      return { ok: true, data: {} };
    },
  };
  const whenDeleted = (key: string) => new Promise<void>((resolve) => (deleteWaiters[key] = resolve));
  return { tcw: tcw as never, kv, revoked, whenDeleted };
}

describe("chat sharing paused", () => {
  it("is paused by default", () => {
    expect(CHAT_SHARING_PAUSED).toBe(true);
  });

  it("refuses to create a share link before any SDK, SQL, or storage call", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    let calls = 0;
    const tcw = {
      sql: { db: () => { calls++; throw new Error("SQL must not be reached"); } },
      sharing: { generate: async () => { calls++; throw new Error("SDK sharing must not be reached"); } },
    } as never;

    const refused = createTinychatShareLink(tcw, "thread-1");

    await expect(refused).rejects.toBeInstanceOf(ChatSharingPausedError);
    await expect(refused).rejects.toMatchObject({
      code: "chat-sharing-paused",
      message: "Chat sharing is paused.",
    });
    expect(calls).toBe(0);
  });

  it("still stores and finds an incoming share link", async () => {
    installStorage();
    const { saveTinychatShareToken, findStoredTinychatShareForThread } = await loadShareModule();

    const saved = saveTinychatShareToken(token("2999-01-01T00:00:00.000Z"));

    expect(saved.threadId).toBe("thread-1");
    expect(findStoredTinychatShareForThread("thread-1")?.id).toBe("share-1");
  });

  it("offers the share action only for a chat that already has a link", () => {
    expect(canOfferChatShare(false)).toBe(false);
    expect(canOfferChatShare(true)).toBe(true);
  });

  it("lists an owner's existing shares while paused and cleans up lapsed ones", async () => {
    const { listOwnedTinychatShares } = await loadShareModule();
    const { tcw, kv } = fakeOwnerTcw();
    seedShare(kv, LIVE, "thread-1", "2999-01-01T00:00:00.000Z");
    seedShare(kv, LAPSED, "thread-2", "2000-01-01T00:00:00.000Z");

    const shares = await listOwnedTinychatShares(tcw);

    expect(shares.map((share) => share.shareId)).toEqual([LIVE]);
    expect(kv.has(shareIndexKeyFor(LAPSED))).toBe(false);
    expect(kv.has(snapshotKeyFor(LAPSED))).toBe(false);
    expect(kv.has(shareIndexKeyFor(LIVE))).toBe(true);
  });

  it("revokes an existing share's delegation, then removes its records, while paused", async () => {
    installStorage();
    const { stopOwnedTinychatShare, listOwnedTinychatShares } = await loadShareModule();
    const { tcw, kv, revoked } = fakeOwnerTcw();
    seedShare(kv, LIVE, "thread-1", "2999-01-01T00:00:00.000Z");

    expect(await stopOwnedTinychatShare(tcw, LIVE)).toEqual({ ok: true });

    expect(revoked).toEqual([`cid-${LIVE}`]);
    expect(kv.size).toBe(0);
    expect(await listOwnedTinychatShares(tcw)).toEqual([]);
  });

  it("a failed revoke while paused leaves the link and its records in place", async () => {
    installStorage();
    const { stopOwnedTinychatShare } = await loadShareModule();
    const { tcw, kv } = fakeOwnerTcw({ failRevoke: true });
    seedShare(kv, LIVE, "thread-1", "2999-01-01T00:00:00.000Z");

    expect(await stopOwnedTinychatShare(tcw, LIVE)).toEqual({ ok: false, stage: "revoke" });

    expect(kv.has(shareIndexKeyFor(LIVE))).toBe(true);
    expect(kv.has(snapshotKeyFor(LIVE))).toBe(true);
  });

  it("still refuses to create a link when the owner already has links", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    const { tcw, kv } = fakeOwnerTcw();
    seedShare(kv, LIVE, "thread-1", "2999-01-01T00:00:00.000Z");
    const before = new Map(kv);

    await expect(createTinychatShareLink(tcw, "thread-1")).rejects.toBeInstanceOf(ChatSharingPausedError);

    expect(kv).toEqual(before);
  });

  it("deleting a chat removes that chat's link records and revokes its delegation while paused", async () => {
    const { tcw, kv, revoked, whenDeleted } = fakeOwnerTcw();
    seedShare(kv, MINE, "thread-a", "2999-01-01T00:00:00.000Z");
    seedShare(kv, OTHER, "thread-b", "2999-01-01T00:00:00.000Z");
    // Share cleanup runs after the delete returns; its last step removes the index record.
    const cleanedUp = whenDeleted(shareIndexKeyFor(MINE));

    await deleteThread(tcw, "thread-a");
    await cleanedUp;

    expect(revoked).toEqual([`cid-${MINE}`]);
    expect(kv.has(shareIndexKeyFor(MINE))).toBe(false);
    expect(kv.has(snapshotKeyFor(MINE))).toBe(false);
    expect(kv.has(shareIndexKeyFor(OTHER))).toBe(true);
    expect(kv.has(snapshotKeyFor(OTHER))).toBe(true);
  }, 2000);
});
