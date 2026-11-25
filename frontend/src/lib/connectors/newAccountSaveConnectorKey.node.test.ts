// The save path itself, against a throwaway loopback node (set TC4112_TEST_NODE; runner /var/tmp/integ/tc4243-node-proof.sh):
// a new account that signed in with the three exact connector keys saves its first key. The node answers network_not_found, the
// save asks once for network.create (the approval is the SDK's own runtime grant, signed here as OpenKey would), and the key lands.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { webSignInManifest } from "../homeFeatures";
import { WEB_APP_MANIFEST } from "../webSignInPrefetch";
import { getConnectorKey, resetVaultSecretCacheForTests, saveConnectorKey } from "./connectorSecrets";
import { encryptionNetworkId } from "./encryptionGrant";

const host = process.env.TC4112_TEST_NODE;
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES;
beforeAll(() => { buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES = "true"; });
afterAll(() => { if (realFlag === undefined) delete buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES; else buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES = realFlag; });

test.skipIf(!host)("the first save of a new account asks once for network.create, then stores the key under its own key", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  resetVaultSecretCacheForTests();
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;
  const network = encryptionNetworkId(address);
  const signIn = webSignInManifest(WEB_APP_MANIFEST, ["connectors"], address);
  const manifest = { ...signIn, permissions: (signIn.permissions ?? []).filter((entry) => entry.path !== network) };
  const node = new TinyCloudNode({
    privateKey, host, prefix: "applications", autoCreateSpace: true, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, manifest,
  });
  await node.signIn();
  try {
    await node.hostOwnedSpace("applications");
    await node.ensureOwnedSpaceHosted("secrets");
    expect(await node.getEncryptionNetwork(network)).toBeNull();
    const tcw = {
      did: node.did,
      secrets: node.secrets,
      session: () => ({ address, chainId: 1 }),
      ensureEncryptionNetwork: () => node.ensureEncryptionNetwork(),
      ensureOwnedSpaceHosted: (space: string) => node.ensureOwnedSpaceHosted(space),
    } as unknown as TinyCloudWeb;
    const asked: PermissionEntry[][] = [];
    const requestApproval = async (permissions: PermissionEntry[], maxExpiryMs: number) => {
      asked.push(permissions);
      await node.grantRuntimePermissions(permissions, { expiry: maxExpiryMs, signMessage: (message: string) => account.signMessage({ message }) });
      return true;
    };
    const save = await saveConnectorKey(tcw, { secretName: "FIREFLIES_API_KEY" }, "new-fireflies-value", { requestApproval });
    expect(save.ok ? "ok" : JSON.stringify(save.error)).toBe("ok");
    expect(asked).toHaveLength(1);
    expect(asked[0].map((entry) => entry.actions)).toEqual([["network.create"]]);
    // A second key finds the network and needs no ask.
    const second = await saveConnectorKey(tcw, { secretName: "GRANOLA_API_KEY" }, "new-granola-value", { requestApproval });
    expect(second.ok ? "ok" : JSON.stringify(second.error)).toBe("ok");
    expect(asked).toHaveLength(1);
    resetVaultSecretCacheForTests();
    for (const [name, value] of [["FIREFLIES_API_KEY", "new-fireflies-value"], ["GRANOLA_API_KEY", "new-granola-value"]]) {
      const read = await node.secrets.get(name, { namedKeyOnly: true });
      expect(read.ok && read.data).toBe(value);
    }
    expect((await getConnectorKey(tcw, { secretName: "FIREFLIES_API_KEY" })).ok).toBe(true);
  } finally { await node.signOut(); }
}, 120_000);
