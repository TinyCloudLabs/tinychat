import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";

const previousHTMLElement = globalThis.HTMLElement;
const previousCustomElements = globalThis.customElements;
globalThis.HTMLElement ??= class {} as never;
globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
// Test-only module-loading boundary: web-sdk defines a custom element at import time.
const { clearTranscriptDelegationSchedule, ensureTranscriptWriterDelegation } = await import("./transcriptDelegation");

const address = "0x0000000000000000000000000000000000000abc";
const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterAll(() => {
  if (previousHTMLElement) globalThis.HTMLElement = previousHTMLElement;
  else Reflect.deleteProperty(globalThis, "HTMLElement");
  if (previousCustomElements) globalThis.customElements = previousCustomElements;
  else Reflect.deleteProperty(globalThis, "customElements");
});
afterEach(() => {
  clearTranscriptDelegationSchedule(address);
  globalThis.fetch = originalFetch;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => { rows.delete(key); },
    setItem: (key, value) => { rows.set(key, value); },
  };
}

/** A signed-in session on `host`; every backend request and every delegation it is asked for is recorded. */
function setup(host: string) {
  const operations: string[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => Promise<unknown>) => action({}) } },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    operations.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/delegations/status") return Response.json({ status: "none", expiresAt: null, verified: false, delivery: "enabled" });
    if (path === "/api/server-info") return Response.json({ did: `did:pkh:eip155:1:${address}` });
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  const db = { query: async () => ({ ok: true, data: { rows: [] } }), execute: async () => ({ ok: true, data: {} }) };
  const tcw = {
    address: () => address,
    hosts: [host],
    session: () => ({ siwe: `Expiration Time: ${new Date(Date.now() + 30 * 86_400_000).toISOString()}`, signature: "signed" }),
    sql: { db: () => db },
    delegateTo: async () => { operations.push("delegateTo"); throw new Error("Stop before serialization"); },
  } as unknown as TinyCloudWeb;
  const sessionStore = { getToken: () => "test-token", getAddress: () => address, isExpired: () => false } as unknown as SessionStore;
  return { operations, tcw, sessionStore };
}

describe("the transcript writer delegation and a node on this computer", () => {
  it("mints nothing and sends nothing to the backend while the host is a local node", async () => {
    const { operations, tcw, sessionStore } = setup("http://127.0.0.1:8000");
    expect(await ensureTranscriptWriterDelegation({ tcw, sessionStore, backendUrl: "https://api.test" })).toBe("disabled");
    expect(operations).toEqual([]);
  });

  it("is unchanged on the default host: it asks the backend, then asks the session to mint", async () => {
    const { operations, tcw, sessionStore } = setup("https://tee.node.tinycloud.xyz");
    await ensureTranscriptWriterDelegation({ tcw, sessionStore, backendUrl: "https://api.test" });
    expect(operations).toContain("GET /api/delegations/status");
    expect(operations).toContain("delegateTo");
  });
});
