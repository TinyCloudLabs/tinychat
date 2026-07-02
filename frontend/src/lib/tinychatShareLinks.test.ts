import { afterEach, describe, expect, it } from "bun:test";

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

describe("tinychat share links", () => {
  it("decodes a tinychat share token", async () => {
    const { decodeTinychatShareToken } = await loadShareModule();
    const decoded = decodeTinychatShareToken(token("2999-01-01T00:00:00.000Z"));

    expect(decoded.threadId).toBe("thread-1");
    expect(decoded.title).toBe("Shared chat");
  });

  it("stores non-expired shares newest first and de-dupes by id", async () => {
    const { listStoredTinychatShares, saveTinychatShareToken } = await loadShareModule();
    installStorage();

    const first = saveTinychatShareToken(token("2999-01-01T00:00:00.000Z", "same"));
    const second = saveTinychatShareToken(token("2999-01-01T00:00:00.000Z", "same"));
    const shares = listStoredTinychatShares();

    expect(first.id).toBe("same");
    expect(second.id).toBe("same");
    expect(shares).toHaveLength(1);
    expect(shares[0].token).toBe(second.token);
  });

  it("rejects expired shares", async () => {
    const { saveTinychatShareToken } = await loadShareModule();
    installStorage();

    expect(() => saveTinychatShareToken(token("2000-01-01T00:00:00.000Z"))).toThrow(
      "expired",
    );
  });
});
