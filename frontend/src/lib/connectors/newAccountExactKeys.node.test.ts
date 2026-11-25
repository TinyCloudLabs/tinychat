// A brand-new account that signs in with the exact connector keys only (no decrypt on the whole encryption network) has no
// encryption network yet, so saving a connector key under its own key needs the network to be created first (an approval
// for network.create, as the bot history path asks for it). Runs against a throwaway loopback node (set TC4112_TEST_NODE;
// the runner is /var/tmp/integ/tc4243-node-proof.sh). Real SDK and real node.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { webSignInManifest } from "../homeFeatures";
import { WEB_APP_MANIFEST } from "../webSignInPrefetch";
import { connectorKeyDecryptGrants, encryptionNetworkId } from "./encryptionGrant";

const host = process.env.TC4112_TEST_NODE;
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES;
beforeAll(() => { buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES = "true"; });
afterAll(() => { if (realFlag === undefined) delete buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES; else buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES = realFlag; });

const KEYS = [
  { name: "FIREFLIES_API_KEY", value: "new-fireflies-value" },
  { name: "GRANOLA_API_KEY", value: "new-granola-value" },
  { name: "REFRESH_TOKEN", scope: "google-meet", value: "new-google-value" },
];

function freshNode() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;
  const signIn = webSignInManifest(WEB_APP_MANIFEST, ["connectors"], address);
  // The sign-in under test asks for the three exact keys and nothing on the whole network.
  const network = encryptionNetworkId(address);
  const manifest = { ...signIn, permissions: (signIn.permissions ?? []).filter((entry) => entry.path !== network) };
  for (const grant of connectorKeyDecryptGrants(address)) expect((manifest.permissions ?? []).some((entry) => entry.path === grant.path)).toBe(true);
  const node = new TinyCloudNode({
    privateKey, host, prefix: "applications", autoCreateSpace: true, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, manifest,
  });
  return { node, address, sign: (message: string) => account.signMessage({ message }) };
}

test.skipIf(!host)("a new account with exact-key grants saves each connector key under its own key once its network exists, and reads it back with that key alone", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  const { node, address, sign } = freshNode();
  await node.signIn();
  try {
    await node.hostOwnedSpace("applications");
    await node.ensureOwnedSpaceHosted("secrets");
    // A new account has no encryption network: the key save cannot make one with the exact-key grants alone.
    const first = await node.secrets.put(KEYS[0].name, KEYS[0].value, { namedKey: true });
    expect(first.ok ? "ok" : first.error.message).toContain("network_not_found");
    // The approval the app asks for on demand creates it.
    await node.grantRuntimePermissions(
      [{ service: "tinycloud.encryption", path: encryptionNetworkId(address), skipPrefix: true, actions: ["network.create"] }],
      { expiry: 3_600_000, signMessage: sign },
    );
    await node.ensureEncryptionNetwork();
    for (const { name, value, scope } of KEYS) {
      const put = await node.secrets.put(name, value, { ...(scope ? { scope } : {}), namedKey: true });
      expect(put.ok ? "ok" : `${put.error.code}: ${put.error.message}`).toBe("ok");
    }
    for (const { name, value, scope } of KEYS) {
      const read = await node.secrets.get(name, { ...(scope ? { scope } : {}), namedKeyOnly: true });
      expect(read.ok && read.data).toBe(value);
    }
  } finally { await node.signOut(); }
}, 120_000);
