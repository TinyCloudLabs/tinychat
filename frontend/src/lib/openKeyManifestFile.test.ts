/**
 * OpenKey admits `apps/<id>/` key grants only after fetching this file from the app's own origin
 * (https://<origin>/.well-known/openkey-manifest.json) and matching its canonical digest, then
 * reads `keys_app_id` and `keys` from it. These checks keep the committed file readable by that
 * admission: valid JSON within its 64 KB cap, a key declaration it accepts, an id that binds to
 * https://tinycloud.chat, and no drift from the manifest the backend serves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WELL_KNOWN = new URL("../../public/.well-known/openkey-manifest.json", import.meta.url);
const ROOT_MANIFEST = new URL("../../../manifest.json", import.meta.url);
const ORIGIN_HOST = "tinycloud.chat";
// OpenKey's limits (apps/api/src/services/manifest-origin-fetch.ts, app-key-gate.ts, key-resource.ts).
const MAX_BYTES = 64 * 1024;
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_ABILITIES = ["key.create", "decrypt", "key.block", "key.unblock"];

const bytes = readFileSync(WELL_KNOWN);
const served = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
const root = JSON.parse(readFileSync(ROOT_MANIFEST, "utf8")) as Record<string, unknown>;

describe("/.well-known/openkey-manifest.json", () => {
  test("is a JSON object OpenKey can fetch within its size cap", () => {
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_BYTES);
    expect(Array.isArray(served)).toBe(false);
    expect(typeof served).toBe("object");
  });

  test("declares one key prefix under apps/<keys_app_id>/ with abilities OpenKey accepts", () => {
    const keysAppId = served.keys_app_id;
    expect(typeof keysAppId === "string" && APP_ID.test(keysAppId)).toBe(true);
    expect(served.keys).toEqual([{ prefix: `apps/${keysAppId}/`, abilities: ["key.create", "decrypt"] }]);
    for (const entry of served.keys as Array<{ abilities: string[] }>) {
      expect(new Set(entry.abilities).size).toBe(entry.abilities.length);
      for (const ability of entry.abilities) expect(KEY_ABILITIES).toContain(ability);
    }
  });

  test("keys_app_id binds to https://tinycloud.chat (the reversed host is the id or its dotted prefix)", () => {
    const reversed = ORIGIN_HOST.split(".").reverse().join(".");
    const id = served.keys_app_id as string;
    expect(id === reversed || id.startsWith(`${reversed}.`)).toBe(true);
  });

  test("is the backend's manifest plus the key declaration and nothing else", () => {
    const { keys_app_id: _id, keys: _keys, ...rest } = served;
    expect(rest).toEqual(root);
  });

  test("the backend's own manifest carries no key declaration", () => {
    expect("keys" in root).toBe(false);
    expect("keys_app_id" in root).toBe(false);
  });
});
