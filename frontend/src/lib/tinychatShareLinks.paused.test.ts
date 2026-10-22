import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_SHARING_PAUSED, ChatSharingPausedError, canOfferChatShare } from "./chatSharing";

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

  it("lists no owned shares and reads no KV while paused", async () => {
    const { listOwnedTinychatShares } = await loadShareModule();
    let kvCalls = 0;
    const tcw = {
      kv: {
        list: async () => {
          kvCalls++;
          throw new Error("KV list must not be reached");
        },
        get: async () => {
          kvCalls++;
          throw new Error("KV get must not be reached");
        },
      },
    } as never;

    expect(await listOwnedTinychatShares(tcw)).toEqual([]);
    expect(kvCalls).toBe(0);
  });
});
