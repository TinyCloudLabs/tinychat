import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadWebManifest } from "./appManifest";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("web manifest loads", () => {
  test("reads the served OpenKey manifest file and returns its key declaration", async () => {
    const file = readFileSync(new URL("../../public/.well-known/openkey-manifest.json", import.meta.url), "utf8");
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(file, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const manifest = await loadWebManifest();
    expect(requested).toEqual(["/.well-known/openkey-manifest.json"]);
    expect(manifest.keys_app_id).toBe("chat.tinycloud.tinychat");
    expect(manifest.keys).toEqual([{ prefix: "apps/chat.tinycloud.tinychat/", abilities: ["key.create", "decrypt"] }]);
  });
});
