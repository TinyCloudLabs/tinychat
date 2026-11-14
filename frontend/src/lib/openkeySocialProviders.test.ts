import { describe, expect, test } from "bun:test";

import { loadOpenKeySocialProviders } from "./openkeyNative";

function fetchReturning(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("loadOpenKeySocialProviders (TC-1233)", () => {
  test("reads the OpenKey API host's provider list without credentials", async () => {
    const { calls, fetchFn } = fetchReturning({ providers: ["google", "apple"] });
    expect(await loadOpenKeySocialProviders("https://openkey.so", fetchFn)).toEqual(["google", "apple"]);
    expect(calls[0].url).toBe("https://api.openkey.so/api/auth/providers");
    expect(calls[0].init?.credentials).toBe("omit");
  });

  test("uses a local OpenKey host as-is", async () => {
    const { calls, fetchFn } = fetchReturning({ providers: [] });
    await loadOpenKeySocialProviders("http://localhost:5183", fetchFn);
    expect(calls[0].url).toBe("http://localhost:5183/api/auth/providers");
  });

  test("keeps only the providers TinyCloud One can offer", async () => {
    const { fetchFn } = fetchReturning({ providers: ["apple", "github", 7, "google"] });
    expect(await loadOpenKeySocialProviders("https://openkey.so", fetchFn)).toEqual(["apple", "google"]);
  });

  test("any failure reads as no providers", async () => {
    expect(await loadOpenKeySocialProviders("https://openkey.so", fetchReturning({ providers: ["apple"] }, 500).fetchFn)).toEqual([]);
    expect(await loadOpenKeySocialProviders("https://openkey.so", fetchReturning({ nope: true }).fetchFn)).toEqual([]);
    expect(await loadOpenKeySocialProviders("https://openkey.so", (async () => { throw new TypeError("offline"); }) as typeof fetch)).toEqual([]);
    expect(await loadOpenKeySocialProviders("not a url", fetchReturning({ providers: ["apple"] }).fetchFn)).toEqual([]);
  });
});
