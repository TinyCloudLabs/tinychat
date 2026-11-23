import { expect, test } from "bun:test";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { connectWallet } from "@tinyboilerplate/client";
import { authorizeBotHistory, refreshBotHistoryKeyDescriptor } from "./historyAuthorization";
import { botHistoryDirectory } from "./botHistoryPath";
import { publishBotHistoryKeyDescriptor } from "./botHistoryKey";
import { readBotHistory } from "./historyRead";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";

const address = `0x${"12".repeat(20)}`;
const networkId = encryptionNetworkId(address);
const generation = "01".repeat(16);
const challenge = "ab".repeat(32);
const now = Date.now();
const session = {
  address, chainId: 1, sessionKey: "fixture", signature: "fixture",
  siwe: `URI: did:key:fixture\nExpiration Time: ${new Date(now + 30 * 86_400_000).toISOString()}`,
};
const descriptor = {
  networkId, keyPath: BOT_HISTORY_KEY_PATH, alg: "x25519-aes256gcm/v1", keyVersion: 1,
  publicEncryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", kind: "deletable", state: "active",
} as const;

test("all-v2 history requests only the exact key, capped at seven days", async () => {
  const prefix = await botHistoryDirectory(address, "main");
  const key = `${prefix}${generation}/1-${challenge}`;
  const requests: unknown[] = [];
  const posted: unknown[] = [];
  const tcw = {
    session: () => session,
    hasPermissions: () => requests.length > 0,
    kvForSpace: () => ({
      list: async () => ({ ok: true, data: { keys: [key] } }),
      get: async () => ({ ok: true, data: { data: { v: 2, keyPath: BOT_HISTORY_KEY_PATH } } }),
    }),
    getEncryptionNetwork: async () => ({}),
    ensureEncryptionNetwork: async () => {},
    setRuntimePermissionSigner() {},
    requestPermissions: async (permissions: unknown, options: unknown) => {
      requests.push([permissions, options]);
      return { approved: true };
    },
    keys: { ensureKey: async () => descriptor },
    signSessionBytes: async () => new Uint8Array(64),
  } as unknown as TinyCloudWeb;
  const connect = (async () => ({ address, openkey: {} })) as unknown as typeof connectWallet;
  await authorizeBotHistory(tcw, connect, async () => ({ enabled: true }), {
    postDescriptor: async envelope => { posted.push(envelope.descriptor); },
  });
  expect(requests).toEqual([[[expect.objectContaining({
    path: `${networkId}/${BOT_HISTORY_KEY_PATH}`, actions: ["key.create", "decrypt"],
  })], { expiryMs: 7 * 86_400_000 }]]);
  expect(posted).toEqual([expect.objectContaining({ keyPath: BOT_HISTORY_KEY_PATH })]);
});

test("background descriptor renewal skips a session without the exact grant", async () => {
  const tcw = {
    session: () => session,
    hasPermissions: () => false,
    get keys() { throw new Error("unexpected key operation"); },
    requestPermissions() { throw new Error("unexpected approval"); },
    delegateTo() { throw new Error("unexpected delegation"); },
  } as unknown as TinyCloudWeb;
  await refreshBotHistoryKeyDescriptor(tcw);
});

for (const failure of [undefined, "exact_key_unavailable", "missing_etag", "descriptor_unavailable", "encrypt_failed",
  "write_failed", "readback_failed", "commit_failed"] as const) {
  test(`foreground reseal ${failure ?? "success"}`, async () => {
    const prefix = await botHistoryDirectory(address, "main");
    const key = `${prefix}${generation}/1-${challenge}`;
    const aad = btoa(JSON.stringify({
      owner: `did:pkh:eip155:1:${address}`, spaceId: makePkhSpaceId(address, 1, "applications"), path: key,
    }));
    const plaintext = new TextEncoder().encode(JSON.stringify({
      v: 1, generation, seq: 1, challenge, record: { type: "user", text: "old history" },
    }));
    const v1 = { v: 1, networkId, aad };
    const v2 = { v: 2, keyPath: BOT_HISTORY_KEY_PATH, networkId, keyVersion: 1, aad };
    const records = new Map<string, unknown>([[key, v1]]);
    const events: string[] = [];
    const reports: unknown[] = [];
    const tcw = {
      session: () => session,
      hasPermissions: () => failure !== "exact_key_unavailable",
      signSessionBytes: async () => new Uint8Array(64),
      kvForSpace: () => ({
        list: async () => ({ ok: true, data: { keys: [key] } }),
        get: async (path: string) => {
          if (path !== key) {
            events.push("readback");
            if (failure === "readback_failed") return { ok: false };
          }
          return { ok: true, data: { data: records.get(path), headers: { etag: failure === "missing_etag" ? undefined : "old" } } };
        },
        put: async (path: string, value: unknown, options: { ifMatch?: string; ifNoneMatch?: string }) => {
          if (path === key) {
            events.push("commit");
            expect(options.ifMatch).toBe("old");
            if (failure === "commit_failed") return { ok: false };
          } else {
            events.push("stage");
            expect(options.ifNoneMatch).toBe("*");
            if (failure === "write_failed") return { ok: false };
          }
          records.set(path, value);
          return { ok: true };
        },
        delete: async (path: string) => { records.delete(path); },
      }),
      encryption: { decryptEnvelope: async () => ({ ok: true, data: plaintext }) },
      keys: {
        ensureKey: async () => {
          if (failure === "descriptor_unavailable") throw new Error("key unavailable");
          return descriptor;
        },
        encrypt: async () => {
          if (failure === "encrypt_failed") throw new Error("encryption refused");
          return v2;
        },
        decrypt: async (envelope: unknown) => {
          expect(envelope).toEqual(v2);
          events.push("named decrypt");
          return plaintext;
        },
      },
    } as unknown as TinyCloudWeb;
    await publishBotHistoryKeyDescriptor(tcw, descriptor, { post: async () => {} });
    const lines = await readBotHistory(tcw, undefined, { reseal: true, onResealReport: report => reports.push(report) });
    expect(lines.map(line => line.text)).toEqual(["old history"]);
    expect([...records.entries()]).toEqual([[key, failure ? v1 : v2]]);
    expect(reports).toEqual([{
      resealed: failure ? 0 : 1,
      failed: failure ? [{ reason: failure }] : [],
    }]);
    if (!failure) expect(events).toEqual(["stage", "readback", "named decrypt", "commit"]);
    if (failure === "readback_failed") expect(events).toEqual(["stage", "readback"]);
  });
}
