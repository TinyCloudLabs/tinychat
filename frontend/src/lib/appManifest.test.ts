import { afterEach, describe, expect, test } from "bun:test";
import { loadWebManifest, manifestUrlWithKeys } from "./appManifest";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("web manifest loads", () => {
  test("the request that reaches the backend carries keys=1", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        manifest_version: 1, app_id: "xyz.tinycloud.tinychat", name: "Chat", defaults: false, permissions: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await loadWebManifest("https://api.example.test/api/manifest");
    expect(requested).toEqual(["https://api.example.test/api/manifest?keys=1"]);
  });

  test("adds the opt-in after an existing query", () => {
    expect(manifestUrlWithKeys("/api/manifest")).toBe("/api/manifest?keys=1");
    expect(manifestUrlWithKeys("/api/manifest?x=1")).toBe("/api/manifest?x=1&keys=1");
  });
});
