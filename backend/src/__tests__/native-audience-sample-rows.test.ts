import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { makeSpaceId, prepareSession, TCWSessionManager } from "@tinycloud/node-sdk-wasm";
import type { Manifest } from "@tinycloud/sdk-core";
import APP_MANIFEST from "../../../manifest.json";
import { nativePermissions } from "../../../frontend/src/lib/openkeyNative.js";
import { hasTinyChatNativeAudience } from "../native-siwe-audience.js";

// The served manifest no longer asks for the Health Log and Recipes databases. A phone build made before that
// change, and a renewal of its session, still carry them; the backend must accept both shapes.
const account = privateKeyToAccount(`0x${"02".repeat(32)}`);
const SQL_ALL = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"];
const OLD_ROWS: Record<string, string[]> = {
  "xyz.tinycloud.sample.healthlog/healthlog": SQL_ALL,
  "xyz.tinycloud.sample.recipes/recipes": SQL_ALL,
};

function nativeAbilities(): Record<string, Record<string, string[]>> {
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of nativePermissions(APP_MANIFEST as Manifest)) {
    (abilities[permission.service.replace(/^tinycloud\./, "")] ??= {})[permission.path] = permission.actions;
  }
  return abilities;
}

function audienceAccepts(abilities: Record<string, Record<string, string[]>>): boolean {
  const manager = new TCWSessionManager();
  manager.createSessionKey("sample-rows");
  const jwk = JSON.parse(manager.jwk("sample-rows")!);
  const issuedAt = new Date();
  const prepared = prepareSession({
    address: account.address,
    chainId: 1,
    domain: "openkey.so",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60_000).toISOString(),
    spaceId: makeSpaceId(account.address, 1, "applications"),
    jwk,
    nonce: "samplerowsnonce1",
    abilities,
  });
  manager.free();
  const message = prepared.siwe as string;
  return hasTinyChatNativeAudience(message, account.address, 1, parseSiweMessage(message).resources as string[]);
}

describe("native sign-in and the two sample databases", () => {
  test("the served manifest no longer lists them", () => {
    const paths = nativePermissions(APP_MANIFEST as Manifest).map((permission) => permission.path);
    for (const name of Object.keys(OLD_ROWS)) expect(paths).not.toContain(name);
  });

  test("a request without them is accepted", () => {
    expect(audienceAccepts(nativeAbilities())).toBe(true);
  });

  test("an older request that still carries them is accepted", () => {
    const abilities = nativeAbilities();
    abilities.sql = { ...abilities.sql, ...OLD_ROWS };
    expect(audienceAccepts(abilities)).toBe(true);
  });

  test("an older request carrying only them, with no TinyChat grant, is still refused", () => {
    expect(audienceAccepts({ sql: OLD_ROWS })).toBe(false);
  });
});
