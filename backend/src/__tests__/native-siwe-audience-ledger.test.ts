// Manifest revision 5 narrows One's broad applications KV grant to one named read-only folder (the Ledger app's).
// The audience gate must accept that folder, keep accepting the old broad root for sessions signed under revision 4,
// and refuse anything wider than the named folder.
import { describe, expect, test } from "bun:test";
import { parseSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";
import { makeSpaceId, prepareSession, TCWSessionManager } from "@tinycloud/node-sdk-wasm";
import { hasTinyChatNativeAudience } from "../native-siwe-audience.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const KV_ALL = ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"];
const KV_READ = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/metadata"];
const OWN_THREADS = { "xyz.tinycloud.tinychat/threads/": ["tinycloud.kv/get", "tinycloud.kv/put"] };

function accepts(kv: Record<string, string[]>): boolean {
  const manager = new TCWSessionManager();
  manager.createSessionKey("ledger-folder");
  const jwk = JSON.parse(manager.jwk("ledger-folder")!);
  const issuedAt = new Date();
  const prepared = prepareSession({
    address: account.address,
    chainId: 1,
    domain: "openkey.so",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60_000).toISOString(),
    spaceId: makeSpaceId(account.address, 1, "applications"),
    jwk,
    nonce: "ledgerfolder01",
    abilities: { kv },
  });
  manager.free();
  const message = prepared.siwe as string;
  return hasTinyChatNativeAudience(message, account.address, 1, parseSiweMessage(message).resources as string[]);
}

describe("native audience: the Ledger folder", () => {
  test("accepts the read-only Ledger folder next to One's own prefix", () => {
    expect(accepts({ ...OWN_THREADS, "xyz.tinycloud.rocinante/": KV_READ })).toBe(true);
  });

  test("still accepts the old broad root next to One's own prefix, for sessions signed under revision 4", () => {
    expect(accepts({ ...OWN_THREADS, "": KV_ALL })).toBe(true);
  });

  test("the Ledger folder alone does not prove a TinyChat sign-in", () => {
    expect(accepts({ "xyz.tinycloud.rocinante/": KV_READ })).toBe(false);
  });

  test("refuses writing or deleting in the Ledger folder", () => {
    for (const actions of [KV_ALL, ["tinycloud.kv/get", "tinycloud.kv/put"], ["tinycloud.kv/del"]]) {
      expect(accepts({ ...OWN_THREADS, "xyz.tinycloud.rocinante/": actions })).toBe(false);
    }
  });

  test("refuses any other folder outside One's own prefix, and a wider or deeper Ledger path", () => {
    for (const path of ["xyz.tinycloud.other/", "xyz.tinycloud.rocinante", "xyz.tinycloud.rocinante/board/", "applications/"]) {
      expect(accepts({ ...OWN_THREADS, [path]: KV_READ })).toBe(false);
    }
  });
});
