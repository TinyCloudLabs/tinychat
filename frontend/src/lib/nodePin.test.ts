import { afterEach, describe, expect, it } from "bun:test";
import { writeNodePin } from "./nodeHost";
import { checkNode, fetchNodeId, isNodeFetchFailure } from "./nodePin";

const ADDRESS = "http://127.0.0.1:8000";
const ID_A = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN1";
const ID_B = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN2";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function useMemoryStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } },
  });
}
afterEach(() => {
  if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("fetchNodeId", () => {
  it("reads nodeId from GET <address>/info and sends nothing else", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const id = await fetchNodeId(ADDRESS, { fetch: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return json({ nodeId: ID_A, version: "1.22.0" }); }) as unknown as typeof fetch });
    expect(id).toBe(ID_A);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${ADDRESS}/info`);
    expect(seen[0]!.init.method).toBe("GET");
    expect(seen[0]!.init.body).toBeUndefined();
    expect(seen[0]!.init.credentials).toBe("omit");
    expect(seen[0]!.init.redirect).toBe("error");
  });

  it("does not ask an address that is not a loopback address", async () => {
    let called = false;
    const spy = (async () => { called = true; return json({ nodeId: ID_A }); }) as unknown as typeof fetch;
    for (const address of ["https://tee.node.tinycloud.xyz", "http://localhost:8000", "http://127.0.0.1:8000/x"]) {
      expect(await fetchNodeId(address, { fetch: spy })).toBeNull();
    }
    expect(called).toBe(false);
  });

  const bad: [string, () => Response | Promise<Response>][] = [
    ["a non-200 answer", () => json({ nodeId: ID_A }, { status: 500 })],
    ["an answer that is not JSON", () => new Response("<html>", { status: 200 })],
    ["JSON without nodeId", () => json({ protocol: 1 })],
    ["a nodeId that is not a did:key", () => json({ nodeId: "did:web:example.com" })],
    ["a nodeId that is not a string", () => json({ nodeId: 7 })],
    ["a null body", () => json(null)],
    ["a body past the size cap", () => json({ nodeId: ID_A, pad: "x".repeat(20_000) })],
    ["a content-length past the size cap", () => json({ nodeId: ID_A }, { headers: { "content-length": "999999" } })],
  ];
  for (const [name, answer] of bad) {
    it(`fails closed on ${name}`, async () => {
      expect(await fetchNodeId(ADDRESS, { fetch: (async () => answer()) as unknown as typeof fetch })).toBeNull();
    });
  }

  it("fails closed when the request throws", async () => {
    expect(await fetchNodeId(ADDRESS, { fetch: (async () => { throw new TypeError("refused"); }) as unknown as typeof fetch })).toBeNull();
  });

  it("gives up on a node that never answers", async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await fetchNodeId(ADDRESS, { fetch: hang, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops reading a body that grows past the cap", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("x".repeat(1024))); },
    });
    const id = await fetchNodeId(ADDRESS, { fetch: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch, maxBytes: 4096 });
    expect(id).toBeNull();
    expect(pulls).toBeLessThan(20);
  });
});

describe("checkNode", () => {
  const answer = (id: string) => ({ fetch: (async () => json({ nodeId: id })) as unknown as typeof fetch });

  it("does not look at the hosted node", async () => {
    let called = false;
    const spy = { fetch: (async () => { called = true; return json({ nodeId: ID_A }); }) as unknown as typeof fetch };
    expect(await checkNode("https://tee.node.tinycloud.xyz", spy)).toEqual({ kind: "hosted" });
    expect(await checkNode(undefined, spy)).toEqual({ kind: "hosted" });
    expect(called).toBe(false);
  });

  it("first use when no ID is saved", async () => {
    useMemoryStorage();
    expect(await checkNode(ADDRESS, answer(ID_A))).toEqual({ kind: "first-use", nodeId: ID_A });
  });

  it("match when the saved ID answers", async () => {
    useMemoryStorage();
    writeNodePin(ADDRESS, ID_A);
    expect(await checkNode(ADDRESS, answer(ID_A))).toEqual({ kind: "match", nodeId: ID_A });
  });

  it("mismatch carries both IDs and never replaces the saved one", async () => {
    useMemoryStorage();
    writeNodePin(ADDRESS, ID_A);
    expect(await checkNode(ADDRESS, answer(ID_B))).toEqual({ kind: "mismatch", savedId: ID_A, currentId: ID_B });
    expect(await checkNode(ADDRESS, answer(ID_A))).toEqual({ kind: "match", nodeId: ID_A });
  });

  it("unreachable, with or without a saved ID", async () => {
    useMemoryStorage();
    const down = { fetch: (async () => { throw new TypeError("refused"); }) as unknown as typeof fetch };
    expect(await checkNode(ADDRESS, down)).toEqual({ kind: "unreachable" });
    writeNodePin(ADDRESS, ID_A);
    expect(await checkNode(ADDRESS, down)).toEqual({ kind: "unreachable" });
  });

  it("blocked: listening, but the app may not read the answer (a node started without CORS)", async () => {
    useMemoryStorage();
    writeNodePin(ADDRESS, ID_A);
    const seen: { url: string; mode?: RequestMode; method?: string; body?: unknown }[] = [];
    const noCors = { fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, mode: init.mode, method: init.method, body: init.body });
      if (init.mode === "no-cors") return new Response(null, { status: 200 });
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch };
    expect(await checkNode(ADDRESS, noCors)).toEqual({ kind: "blocked" });
    expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${ADDRESS}/info`, `GET ${ADDRESS}/info`]);
    expect(seen.map((call) => call.mode)).toEqual([undefined, "no-cors"]);
    expect(seen.every((call) => call.body === undefined)).toBe(true);
  });

  it("an answer that is not a node's /info is unreachable, not blocked", async () => {
    useMemoryStorage();
    for (const answer of [json({ hello: "world" }), new Response("<html>", { status: 200 }), json({ nodeId: ID_A }, { status: 502 })]) {
      expect(await checkNode(ADDRESS, { fetch: (async () => answer.clone()) as unknown as typeof fetch })).toEqual({ kind: "unreachable" });
    }
  });
});

describe("isNodeFetchFailure", () => {
  it("recognises the SDK's failure to read /info and plain network failures, and nothing else", () => {
    expect(isNodeFetchFailure(Object.assign(new Error("Failed to fetch node info at http://127.0.0.1:8000."), { name: "VersionCheckError" }))).toBe(true);
    expect(isNodeFetchFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNodeFetchFailure(new TypeError("Load failed"))).toBe(true);
    expect(isNodeFetchFailure(new Error("The user rejected the request"))).toBe(false);
    expect(isNodeFetchFailure(new Error("sign-in failed"))).toBe(false);
    expect(isNodeFetchFailure("Failed to fetch")).toBe(false);
    expect(isNodeFetchFailure(null)).toBe(false);
  });
});
