// The save's own ask, with no test seam: saveConnectorKey -> the real stepUpForApp -> the SDK's requestPermissions (TC-4243).
// Only the wallet connect is stubbed, so no OpenKey window opens.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

// bun's mock.module is process-wide, so the real module is put back when this file is done.
const actualClient = await import("@tinyboilerplate/client");
afterAll(() => { mock.module("@tinyboilerplate/client", () => actualClient); });
mock.module("@tinyboilerplate/client", () => ({
  ...actualClient,
  connectWallet: async () => ({ address: ADDRESS, openkey: { signMessage: async () => ({ signature: "0x00" }) } }),
}));

import { resetVaultSecretCacheForTests, saveConnectorKey } from "./connectorSecrets";
import { encryptionNetworkId } from "./encryptionGrant";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const DAY_MS = 86_400_000;

const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realBuildFlag = buildEnv[BUILD_FLAG];
beforeEach(() => { resetVaultSecretCacheForTests(); buildEnv[BUILD_FLAG] = "true"; });
afterAll(() => { if (realBuildFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realBuildFlag; });

test("the real ask is one network.create entry on the account's network, lasting one hour at most though the session has days left", async () => {
  const requested: { permissions: { actions: string[]; path: string }[]; options: { expiryMs?: number } }[] = [];
  const siwe = `Expiration Time: ${new Date(Date.now() + 7 * DAY_MS).toISOString()}`;
  let puts = 0;
  const tcw = {
    did: `did:pkh:eip155:1:${ADDRESS}`,
    secrets: {
      isUnlocked: true,
      put: async () => (++puts === 1
        ? { ok: false, error: { code: "STORAGE_ERROR", message: "failed to tinycloud.encryption/key.create: network_not_found" } }
        : { ok: true }),
    },
    session: () => ({ address: ADDRESS, chainId: 1, sessionKey: "k", siwe }),
    setRuntimePermissionSigner: () => {},
    requestPermissions: async (permissions: { actions: string[]; path: string }[], options: { expiryMs?: number }) => {
      requested.push({ permissions, options });
      return { approved: true };
    },
    hasPermissions: () => true,
    ensureEncryptionNetwork: async () => ({}),
  } as unknown as TinyCloudWeb;

  const result = await saveConnectorKey(tcw, { secretName: "FIREFLIES_API_KEY" }, "k1");

  expect(result.ok).toBe(true);
  expect(puts).toBe(2);
  expect(requested).toHaveLength(1);
  const [{ permissions, options }] = requested;
  expect(permissions).toHaveLength(1);
  expect(permissions[0].actions).toEqual(["network.create"]);
  expect(permissions[0].path).toBe(encryptionNetworkId(ADDRESS, 1));
  expect(options.expiryMs).toBeDefined();
  expect(options.expiryMs!).toBeLessThanOrEqual(3_600_000);
  expect(options.expiryMs!).toBeGreaterThan(0);
});
