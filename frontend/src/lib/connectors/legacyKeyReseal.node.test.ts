// Moving older connector keys onto their own keys, against a throwaway loopback node (set TC4112_TEST_NODE; the runner is
// /var/tmp/integ/tc4112-node-proof.sh). Real SDK and real node; the OpenKey screen is stood in for by the owner's key.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { webSignInManifest } from "../homeFeatures";
import { WEB_APP_MANIFEST } from "../webSignInPrefetch";
import { encryptionNetworkId, legacyNetworkDecryptRequest, LEGACY_NETWORK_APPROVAL_MAX_MS } from "./encryptionGrant";
import { moveLegacyConnectorKeys, probeConnectorKeys, resolveLegacyConnectorKeys } from "./legacyKeyReseal";

const host = process.env.TC4112_TEST_NODE;
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES;
beforeAll(() => { buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES = "true"; });
afterAll(() => { if (realFlag === undefined) delete buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES; else buildEnv.VITE_CONNECTOR_NAMED_KEY_WRITES = realFlag; });

const FIREFLIES = { name: "FIREFLIES_API_KEY", value: "legacy-fireflies-value" };
const GRANOLA = { name: "GRANOLA_API_KEY", value: "legacy-granola-value" };
const GOOGLE = { name: "REFRESH_TOKEN", scope: "google-meet", value: "legacy-google-value" };

function newNode(privateKey: `0x${string}`, address: string, withConnectorGrants: boolean) {
  return new TinyCloudNode({
    privateKey, host, prefix: "applications", autoCreateSpace: true, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false,
    manifest: webSignInManifest(WEB_APP_MANIFEST, withConnectorGrants ? ["connectors"] : [], address),
  });
}

/** What the page's `tcw` offers the older-keys step, backed by a node session. The approval is the owner's key, no screen. */
function pageTcw(node: TinyCloudNode, sign: (message: string) => Promise<string>, grants: { expiryMs: number[] }) {
  return {
    secrets: node.secrets,
    kv: node.kv,
    session: () => node.session,
    setRuntimePermissionSigner: () => {},
    requestPermissions: async (permissions: PermissionEntry[], options: { expiryMs: number }) => {
      grants.expiryMs.push(options.expiryMs);
      await node.grantRuntimePermissions(permissions, { expiry: options.expiryMs, signMessage: sign });
      return { approved: true };
    },
    hasPermissions: node.hasRuntimePermissions.bind(node),
  } as unknown as TinyCloudWeb;
}

async function seed() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;
  const sign = (message: string) => account.signMessage({ message });
  // An older owner session: whole-network decrypt, so it can write network-sealed (older) secrets.
  const writer = newNode(privateKey, address, true);
  await writer.signIn();
  await writer.hostOwnedSpace("applications");
  await writer.ensureOwnedSpaceHosted("secrets");
  await writer.grantRuntimePermissions([{
    service: "tinycloud.encryption", path: encryptionNetworkId(address), skipPrefix: true, actions: ["network.create", "decrypt"],
  }], { expiry: 3_600_000, signMessage: sign });
  await writer.ensureEncryptionNetwork();
  for (const { name, value, scope } of [FIREFLIES, GRANOLA, GOOGLE]) {
    const put = await writer.secrets.put(name, value, scope ? { scope } : undefined);
    if (!put.ok) throw new Error(`seed ${name}: ${put.error.code}`);
  }
  await writer.signOut();
  // The sign-in a person gets after the change: exact keys only.
  const node = newNode(privateKey, address, true);
  await node.signIn();
  return { node, address, sign };
}

test.skipIf(!host)("older keys are told apart without a decrypt, then moved and read back through their own keys", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  const { node, address, sign } = await seed();
  try {
    const grants = { expiryMs: [] as number[] };
    const tcw = pageTcw(node, sign, grants);
    // Exact-key grants cannot open a network-sealed secret, and the probe does not need to.
    const denied = await node.secrets.get(FIREFLIES.name);
    expect(denied.ok).toBe(false);
    expect(await probeConnectorKeys(tcw)).toEqual({
      "secrets/fireflies_api_key": "legacy", "secrets/granola_api_key": "legacy", "secrets/scoped/google-meet/refresh_token": "legacy",
    });
    expect(grants.expiryMs).toEqual([]);
    expect(await resolveLegacyConnectorKeys(tcw, address, async () => ({
      address, openkey: { signMessage: async ({ message }: { message: string }) => ({ signature: await sign(message) }) },
    }))).toBe("moved");
    expect(grants.expiryMs).toHaveLength(1);
    expect(grants.expiryMs[0]).toBeLessThanOrEqual(LEGACY_NETWORK_APPROVAL_MAX_MS);
    expect(await probeConnectorKeys(tcw)).toEqual({
      "secrets/fireflies_api_key": "current", "secrets/granola_api_key": "current", "secrets/scoped/google-meet/refresh_token": "current",
    });
    // Each now opens through its own key alone.
    for (const { name, value, scope } of [FIREFLIES, GRANOLA, GOOGLE]) {
      const read = await node.secrets.get(name, { ...(scope ? { scope } : {}), namedKeyOnly: true });
      expect(read.ok && read.data).toBe(value);
    }
    // Nothing left to move: no prompt.
    expect(await resolveLegacyConnectorKeys(tcw, address)).toBe("nothing");
    expect(grants.expiryMs).toHaveLength(1);
  } finally { await node.signOut(); }
}, 120_000);

test.skipIf(!host)("a re-put that fails leaves the older key as it was, unmarked, and a later attempt moves it", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  const { node, address, sign } = await seed();
  try {
    const grants = { expiryMs: [] as number[] };
    const tcw = pageTcw(node, sign, grants);
    await node.grantRuntimePermissions(legacyNetworkDecryptRequest(address) as PermissionEntry[], { expiry: 3_600_000, signMessage: sign });
    // The conditional write the SDK's move makes is the only request carrying If-Match: fail exactly that one.
    const realFetch = globalThis.fetch;
    let failures = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (new Headers(init?.headers).has("if-match")) { failures++; return new Response("injected", { status: 500 }); }
      return realFetch(input, init);
    }, { preconnect: realFetch.preconnect });
    const failed = await moveLegacyConnectorKeys(tcw).finally(() => { globalThis.fetch = realFetch; });
    expect(failures).toBeGreaterThan(0);
    expect(failed.moved).toEqual([]);
    expect(failed.failed.map(({ code }) => code)).toEqual(["reseal_write_failed", "reseal_write_failed", "reseal_write_failed"]);
    // Still the older copy, still readable through the whole network, and no marker.
    expect(await probeConnectorKeys(tcw)).toEqual({
      "secrets/fireflies_api_key": "legacy", "secrets/granola_api_key": "legacy", "secrets/scoped/google-meet/refresh_token": "legacy",
    });
    const still = await node.secrets.get(GRANOLA.name);
    expect(still.ok && still.data).toBe(GRANOLA.value);
    const marker = await node.kv.get(`${CONNECTORS_KV_PREFIX}/legacy-key-moved/secrets/granola_api_key`);
    expect(marker.ok).toBe(false);
    const retried = await moveLegacyConnectorKeys(tcw);
    expect(retried.failed).toEqual([]);
    expect(retried.moved).toHaveLength(3);
    const read = await node.secrets.get(GRANOLA.name, { namedKeyOnly: true });
    expect(read.ok && read.data).toBe(GRANOLA.value);
  } finally { await node.signOut(); }
}, 120_000);
