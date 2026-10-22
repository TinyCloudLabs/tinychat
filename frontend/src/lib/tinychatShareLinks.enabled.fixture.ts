// Runs only inside a child `bun test` process (see tinychatShareLinks.test.ts),
// so the chatSharing mock cannot reach the paused-behaviour tests.
import { afterEach, describe, expect, it, mock } from "bun:test";
// The paused behaviour is covered in tinychatShareLinks.paused.test.ts.
mock.module("./chatSharing", () => ({
  CHAT_SHARING_PAUSED: false,
  ChatSharingPausedError: class ChatSharingPausedError extends Error {},
  canOfferChatShare: () => true,
}));

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
  (globalThis as { window?: unknown }).window = { localStorage, location: { href: "https://tinychat.example/" } };
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

const THREAD_A_TEXT = "Controlled thread A text";
const THREAD_B_TEXT = "Controlled thread B text";
const SETTINGS_MARKER = "SETTINGS-MARKER-7f3a";
const MEMORY_MARKER = "MEMORY-MARKER-7f3a";
const COMPACTION_MARKER = "COMPACTION-MARKER-7f3a";
const OVERSIZED_TEXT = "x".repeat(300 * 1024);

const THREAD_ROWS = [
  ["thread-a", "Thread A", "model-x", "2026-01-01", "2026-01-01"],
  ["thread-b", "Thread B", "model-x", "2026-01-01", "2026-01-01"],
  ["thread-big", "Big", "model-x", "2026-01-01", "2026-01-01"],
];

const MESSAGE_ROWS: Record<string, string[]> = {
  "thread-a": [JSON.stringify({ message: { id: "a1", role: "user", createdAt: "2026-01-02T03:04:05.000Z", content: [{ type: "text", text: THREAD_A_TEXT }] } })],
  "thread-b": [JSON.stringify({ message: { id: "b1", role: "user", content: [{ type: "text", text: THREAD_B_TEXT }] } })],
  "thread-big": [JSON.stringify({ message: { id: "big1", role: "user", content: [{ type: "text", text: OVERSIZED_TEXT }] } })],
};

// Fake SDK surface: KV is an in-memory map, sharing records each grant request.
// Rows for settings, memory and compactions exist in the fake database, so a
// snapshot that read them would contain the markers.
function fakeChatTcw(options: { failGrant?: boolean; failRevoke?: boolean; failDelete?: boolean } = {}) {
  const kv = new Map<string, string>();
  const grants: Array<{ path: string; actions: string[]; expiry: Date }> = [];
  const revoked: string[] = [];
  const deleted: string[] = [];
  const db = {
    batch: async () => ({ ok: true, data: { rows: [] } }),
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM threads WHERE id")) {
        const row = THREAD_ROWS.find((r) => r[0] === params[0]);
        return { ok: true, data: { rows: row ? [row] : [] } };
      }
      if (sql.includes("FROM messages WHERE thread_id")) {
        return { ok: true, data: { rows: (MESSAGE_ROWS[String(params[0])] ?? []).map((payload) => [payload]) } };
      }
      if (/FROM (settings|memory|compactions)/.test(sql)) {
        return { ok: true, data: { rows: [[SETTINGS_MARKER], [MEMORY_MARKER], [COMPACTION_MARKER]] } };
      }
      return { ok: true, data: { rows: [] } };
    },
  };
  const tcw = {
    sql: { db: () => db },
    kv: {
      put: async (key: string, value: string) => {
        kv.set(key, value);
        return { ok: true, data: {} };
      },
      get: async (key: string) =>
        kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { message: "not found" } },
      delete: async (key: string) => {
        deleted.push(key);
        if (options.failDelete) return { ok: false, error: { message: "Controlled delete failure" } };
        kv.delete(key);
        return { ok: true, data: {} };
      },
      list: async ({ path }: { path: string }) => ({
        ok: true,
        data: { keys: [...kv.keys()].filter((key) => key.startsWith(path)) },
      }),
    },
    sharing: {
      generate: async (args: { path: string; actions: string[]; expiry: Date }) => {
        grants.push(args);
        if (options.failGrant) return { ok: false, error: { message: "Controlled grant failure" } };
        return { ok: true, data: { token: `sdk-token-${grants.length}`, expiresAt: args.expiry } };
      },
      decodeLink: (sdkToken: string) => {
        const grant = grants[Number(sdkToken.replace("sdk-token-", "")) - 1];
        return {
          host: "https://node.example",
          spaceId: "space",
          keyDid: "did:key:z6MkKey#key-1",
          key: { kty: "OKP" },
          delegation: { cid: `cid-${sdkToken}` },
          path: grant?.path,
        };
      },
    },
    revokeDelegation: async (cid: string) => {
      if (options.failRevoke) return { ok: false, error: { message: "Controlled revoke failure" } };
      revoked.push(cid);
      return { ok: true, data: {} };
    },
  };
  return { tcw: tcw as never, kv, grants, revoked, deleted };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = originalHTMLElement;
  (globalThis as { customElements?: unknown }).customElements = originalCustomElements;
});

function encodeShareToken(payload: object): string {
  return `tcchat1:${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function snapshotJson(text: string): string {
  return JSON.stringify({
    format: "tinychat.share.snapshot",
    version: 1,
    title: "Stored",
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "user", text, timestamp: "2026-01-01T00:00:00.000Z" }],
  });
}

// Viewer-side KV fake: records every path the viewer asks for.
function viewerKv(kv: Map<string, string>, opened: string[]) {
  return {
    get: async (path: string) => {
      opened.push(path);
      return kv.has(path)
        ? { ok: true, data: { data: kv.get(path) } }
        : { ok: false, error: { message: "not found" } };
    },
  } as never;
}

// The decoder must refuse the token before any KV is opened: the opener throws if it runs.
async function expectViewerRefuses(payload: object, name: string): Promise<void> {
  const { loadSharedThreadFromToken } = await loadShareModule();
  await expect(
    loadSharedThreadFromToken(encodeShareToken(payload), async () => {
      throw new Error(`${name}: opener must not be called`);
    }),
  ).rejects.toThrow("Unsupported TinyCloud Chat share link");
}

describe("tinychat share links", () => {
  it("rejects sharing a local validation thread before invoking the SDK", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    const { useLocalThreadStorage, appendMessage } = await import("./threadStore");
    let sdkCalls = 0;
    const tcw = useLocalThreadStorage({
      sql: { db: () => { throw new Error("Production SQL must not be reached"); } },
      sharing: { generate: async () => { sdkCalls++; throw new Error("SDK sharing must not be reached"); } },
    } as never);
    await appendMessage(tcw, "local-share", {
      message: { id: "local-user", role: "user", content: [{ type: "text", text: "Controlled local chat" }] },
    } as never);

    await expect(createTinychatShareLink(tcw, "local-share")).rejects.toThrow("Sharing is disabled during local validation");
    expect(sdkCalls).toBe(0);
  });

  it("creates the share grant on the snapshot key with only the get action", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    const { THREADS_SQL_DB_NAME } = await import("./threadKeys");
    installStorage();
    const chat = fakeChatTcw();

    const result = await createTinychatShareLink(chat.tcw, "thread-a");

    expect(chat.grants).toHaveLength(1);
    expect(chat.grants[0]).toMatchObject({ actions: ["tinycloud.kv/get"] });
    expect(chat.grants[0].path).toBe(`${THREADS_SQL_DB_NAME}/shares/${result.payload.id}`);
    expect(result.payload.key).toBe(chat.grants[0].path);
  });

  it("a snapshot contains only the shared thread's title and message text", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();

    const result = await createTinychatShareLink(chat.tcw, "thread-a");

    expect(JSON.parse(chat.kv.get(result.payload.key) ?? "null")).toEqual({
      format: "tinychat.share.snapshot",
      version: 1,
      title: "Thread A",
      createdAt: expect.any(String),
      messages: [{ role: "user", text: THREAD_A_TEXT, timestamp: "2026-01-02T03:04:05.000Z" }],
    });
  });

  it("the snapshot writer creates keys only directly under the shares prefix", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    const { THREADS_SQL_DB_NAME } = await import("./threadKeys");
    installStorage();
    const chat = fakeChatTcw();

    const result = await createTinychatShareLink(chat.tcw, "thread-a");

    const sharesPrefix = `${THREADS_SQL_DB_NAME}/shares/`;
    const shareKeys = [...chat.kv.keys()].filter((key) => key.startsWith(sharesPrefix));
    expect(shareKeys).toEqual([result.payload.key]);
    expect(result.payload.key.slice(sharesPrefix.length)).not.toContain("/");
  });

  it("a snapshot keeps only the text parts of each message", async () => {
    const { buildShareSnapshot } = await loadShareModule();
    const snapshot = buildShareSnapshot(
      {
        id: "thread-x",
        title: "X",
        model: "model-x",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [
          {
            message: {
              id: "u1",
              role: "user",
              createdAt: new Date("2026-01-02T03:04:05.000Z"),
              content: [
                { type: "text", text: "hello" },
                { type: "image", image: "data:image/png;base64,AAAA" },
              ],
              attachments: [{ id: "file-1" }],
            },
            parentId: null,
          },
        ],
      } as never,
      "2026-01-05T00:00:00.000Z",
    );

    expect(snapshot.messages).toEqual([{ role: "user", text: "hello", timestamp: "2026-01-02T03:04:05.000Z" }]);
  });

  it("a snapshot rebuilds into a linear thread for the viewer", async () => {
    const { buildShareSnapshot, snapshotItems } = await loadShareModule();
    const snapshot = JSON.parse(
      JSON.stringify(
        buildShareSnapshot(
          {
            id: "thread-x",
            title: "X",
            model: "model-x",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            messages: [
              {
                message: { id: "u1", role: "user", createdAt: new Date("2026-01-02T03:04:05.000Z"), content: [{ type: "text", text: "question" }] },
                parentId: null,
              },
              {
                message: { id: "a1", role: "assistant", createdAt: new Date("2026-01-02T03:04:09.000Z"), content: [{ type: "text", text: "answer" }] },
                parentId: "u1",
              },
            ],
          } as never,
          "2026-01-05T00:00:00.000Z",
        ),
      ),
    );

    const items = snapshotItems("share-1", snapshot.messages);

    expect(items.map((item) => [item.message.id, item.parentId, item.message.role])).toEqual([
      ["share-1-0", null, "user"],
      ["share-1-1", "share-1-0", "assistant"],
    ]);
    expect(items[1].message.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("a snapshot of one thread never includes another thread's messages", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();

    const result = await createTinychatShareLink(chat.tcw, "thread-a");

    expect(chat.kv.get(result.payload.key)).not.toContain(THREAD_B_TEXT);
  });

  it("a snapshot has no settings or memory entries", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();

    const result = await createTinychatShareLink(chat.tcw, "thread-a");
    const stored = chat.kv.get(result.payload.key) ?? "";

    expect(stored).not.toContain(SETTINGS_MARKER);
    expect(stored).not.toContain(MEMORY_MARKER);
    expect(stored).not.toContain(COMPACTION_MARKER);
  });

  it("refuses a chat whose snapshot is over 256 KiB before storing anything", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();

    await expect(createTinychatShareLink(chat.tcw, "thread-big")).rejects.toThrow("This chat is too large to share");
    expect(chat.kv.size).toBe(0);
    expect(chat.grants).toHaveLength(0);
  });

  it("a failed grant leaves no snapshot behind", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw({ failGrant: true });

    await expect(createTinychatShareLink(chat.tcw, "thread-a")).rejects.toThrow("Controlled grant failure");
    expect(chat.kv.size).toBe(0);
  });

  it("the lifetime defaults to 7 days and clamps to 1..365 days", async () => {
    const { normalizeDurationDays } = await loadShareModule();

    expect(normalizeDurationDays()).toBe(7);
    expect(normalizeDurationDays(0.2)).toBe(1);
    expect(normalizeDurationDays(30)).toBe(30);
    expect(normalizeDurationDays(1000)).toBe(365);
  });

  it("the share grant expires after the clamped lifetime", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();

    await createTinychatShareLink(chat.tcw, "thread-a", { durationDays: 1000 });

    expect(Math.round((chat.grants[0].expiry.getTime() - Date.now()) / 86_400_000)).toBe(365);
  });

  it("a created share token decodes as a snapshot share", async () => {
    const { createTinychatShareLink, decodeTinychatShareToken } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();

    const result = await createTinychatShareLink(chat.tcw, "thread-a");

    expect(decodeTinychatShareToken(result.token)).toMatchObject({ version: 2, threadId: "thread-a", title: "Thread A" });
  });

  it("owners list a share and revoke it", async () => {
    const { createTinychatShareLink, listOwnedTinychatShares, listStoredTinychatShares, stopOwnedTinychatShare } =
      await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();
    const result = await createTinychatShareLink(chat.tcw, "thread-a");

    expect(await listOwnedTinychatShares(chat.tcw)).toMatchObject([
      { shareId: result.payload.id, threadId: "thread-a", title: "Thread A" },
    ]);

    expect(await stopOwnedTinychatShare(chat.tcw, result.payload.id)).toEqual({ ok: true });

    expect(chat.revoked).toEqual(["cid-sdk-token-1"]);
    expect(chat.kv.size).toBe(0);
    expect(await listOwnedTinychatShares(chat.tcw)).toEqual([]);
    expect(listStoredTinychatShares()).toEqual([]);
  });

  it("decodes a tinychat share token", async () => {
    const { decodeTinychatShareToken } = await loadShareModule();
    const decoded = decodeTinychatShareToken(token("2999-01-01T00:00:00.000Z"));

    expect(decoded.threadId).toBe("thread-1");
    expect(decoded.title).toBe("Shared chat");
  });

  it("stores non-expired shares newest first and de-dupes by id", async () => {
    const { findStoredTinychatShareForThread, listStoredTinychatShares, saveTinychatShareToken } =
      await loadShareModule();
    installStorage();

    const first = saveTinychatShareToken(token("2999-01-01T00:00:00.000Z", "same"));
    const second = saveTinychatShareToken(token("2999-01-01T00:00:00.000Z", "same"));
    const shares = listStoredTinychatShares();

    expect(first.id).toBe("same");
    expect(second.id).toBe("same");
    expect(shares).toHaveLength(1);
    expect(shares[0].token).toBe(second.token);
    expect(findStoredTinychatShareForThread("thread-1")?.token).toBe(second.token);
  });

  it("rejects expired shares", async () => {
    const { saveTinychatShareToken } = await loadShareModule();
    installStorage();

    expect(() => saveTinychatShareToken(token("2000-01-01T00:00:00.000Z"))).toThrow(
      "expired",
    );
  });

  it("stores created shares at their createdAt timestamp", async () => {
    const { findStoredTinychatShareForThread, saveCreatedTinychatShare } =
      await loadShareModule();
    installStorage();
    const expiresAt = "2999-01-01T00:00:00.000Z";
    const shareToken = token(expiresAt, "created-share");
    const payload = {
      ...JSON.parse(atob(shareToken.slice("tcchat1:".length))),
      expiresAt,
    };

    const stored = saveCreatedTinychatShare(shareToken, payload);

    expect(stored.acceptedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(findStoredTinychatShareForThread("thread-1")?.id).toBe("created-share");
  });

  it("a viewer refuses a token whose granted path is another share's snapshot", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();
    const a = await createTinychatShareLink(chat.tcw, "thread-a");
    const b = await createTinychatShareLink(chat.tcw, "thread-b");
    await expectViewerRefuses({ ...a.payload, kv: { ...a.payload.kv, path: b.payload.key } }, "crossed grant path");
  });

  it("the reader opens the granted path, never the share object's key", async () => {
    const { createTinychatShareLink, decodeTinychatShareToken, readSnapshotFromShare } = await loadShareModule();
    const { snapshotKeyFor } = await import("./shareRecords");
    installStorage();
    const chat = fakeChatTcw();
    const a = await createTinychatShareLink(chat.tcw, "thread-a");
    const decoded = decodeTinychatShareToken(a.token);
    if (decoded.version !== 2) throw new Error("expected a snapshot share");
    // Built after decode: `key` names another share, so the reader must ignore it.
    const share = { ...decoded, key: snapshotKeyFor(crypto.randomUUID()) };
    const reads: Array<{ path: string; options: { maxResponseBytes?: number } }> = [];
    const kv = {
      get: async (path: string, options: { maxResponseBytes?: number }) => {
        reads.push({ path, options });
        return chat.kv.has(path)
          ? { ok: true, data: { data: chat.kv.get(path) } }
          : { ok: false, error: { message: "not found" } };
      },
    } as never;

    const thread = await readSnapshotFromShare(share, async () => kv);

    expect(reads.map((read) => read.path)).toEqual([decoded.kv.path]);
    expect(reads[0].options.maxResponseBytes).toBeGreaterThanOrEqual(256 * 1024);
    expect(JSON.stringify(thread)).toContain(THREAD_A_TEXT);
    expect(JSON.stringify(thread)).not.toContain(THREAD_B_TEXT);
  });

  it("a viewer refuses a token whose key or granted path is not this share's snapshot", async () => {
    const { createTinychatShareLink } = await loadShareModule();
    const { SNAPSHOT_KEY_PREFIX, shareIndexKeyFor, snapshotKeyFor } = await import("./shareRecords");
    installStorage();
    const chat = fakeChatTcw();
    const { payload } = await createTinychatShareLink(chat.tcw, "thread-a");
    const id = payload.id;
    const otherKey = snapshotKeyFor(crypto.randomUUID());
    const traversal = `${SNAPSHOT_KEY_PREFIX}../share-index/${id}`;
    const refused: Array<[string, object]> = [
      ["traversal out of the shares folder", { ...payload, kv: { ...payload.kv, path: traversal } }],
      ["owner index key as the granted path", { ...payload, kv: { ...payload.kv, path: shareIndexKeyFor(id) } }],
      ["extra path segment", { ...payload, kv: { ...payload.kv, path: `${payload.key}/extra` } }],
      ["owner index key as the payload key", { ...payload, key: shareIndexKeyFor(id) }],
      ["non-UUID share id", { ...payload, id: "not-a-uuid" }],
      ["another share's snapshot as key and granted path", { ...payload, key: otherKey, kv: { ...payload.kv, path: otherKey } }],
      ["traversal as key and granted path", { ...payload, key: traversal, kv: { ...payload.kv, path: traversal } }],
      ["extra segment as key and granted path", { ...payload, key: `${payload.key}/extra`, kv: { ...payload.kv, path: `${payload.key}/extra` } }],
    ];
    for (const [name, candidate] of refused) {
      await expectViewerRefuses(candidate, name);
    }
  });

  it("a viewer refuses a stored snapshot over 256 KiB before parsing it", async () => {
    const { createTinychatShareLink, loadSharedThreadFromToken } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw();
    const { token, payload } = await createTinychatShareLink(chat.tcw, "thread-a");
    // Valid snapshot JSON: only the size bound can reject it.
    chat.kv.set(payload.key, snapshotJson(OVERSIZED_TEXT));
    const opened: string[] = [];

    await expect(loadSharedThreadFromToken(token, async () => viewerKv(chat.kv, opened))).rejects.toThrow(
      "This shared chat could not be read",
    );
    expect(opened).toEqual([payload.key]);
  });

  it("a failed revoke keeps the share listed and deletes nothing", async () => {
    const {
      createTinychatShareLink,
      listOwnedTinychatShares,
      listStoredTinychatShares,
      shareStopFailureMessage,
      stopOwnedTinychatShare,
    } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw({ failRevoke: true });
    const result = await createTinychatShareLink(chat.tcw, "thread-a");
    const before = new Map(chat.kv);

    const outcome = await stopOwnedTinychatShare(chat.tcw, result.payload.id);

    expect(outcome).toEqual({ ok: false, stage: "revoke" });
    if (outcome.ok) throw new Error("expected a failed stop");
    expect(shareStopFailureMessage(outcome.stage)).toBe(
      "Could not stop this share. It is still active. Try again.",
    );
    expect(JSON.stringify(outcome)).not.toContain("Controlled revoke failure");
    expect(chat.deleted).toEqual([]);
    expect(chat.kv).toEqual(before);
    expect(await listOwnedTinychatShares(chat.tcw)).toMatchObject([{ shareId: result.payload.id }]);
    expect(listStoredTinychatShares()).toHaveLength(1);
  });

  it("a stop that revoked but could not remove the owner's copy reports the cleanup stage", async () => {
    const {
      createTinychatShareLink,
      listOwnedTinychatShares,
      shareStopFailureMessage,
      stopOwnedTinychatShare,
    } = await loadShareModule();
    installStorage();
    const chat = fakeChatTcw({ failDelete: true });
    const result = await createTinychatShareLink(chat.tcw, "thread-a");

    const outcome = await stopOwnedTinychatShare(chat.tcw, result.payload.id);

    expect(outcome).toEqual({ ok: false, stage: "cleanup" });
    if (outcome.ok) throw new Error("expected a failed stop");
    expect(shareStopFailureMessage(outcome.stage)).toBe("Could not finish stopping this share. Try again.");
    expect(chat.revoked).toEqual(["cid-sdk-token-1"]);
    expect(chat.deleted).toEqual([result.payload.key]);
    expect(await listOwnedTinychatShares(chat.tcw)).toMatchObject([{ shareId: result.payload.id }]);
  });
});
