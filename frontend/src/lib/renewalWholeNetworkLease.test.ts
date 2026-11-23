import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadRenewalReceipt, saveRenewalReceipt } from "@tinyboilerplate/client";
import { NodeUserAuthorization } from "@tinycloud/node-sdk";
import type { Manifest } from "@tinycloud/web-sdk";
import { admitSignInRenewal, renewalRestoreFor, verifiedRenewalLease } from "./renewalReceipt";
import { leasedSession, type SignedResources } from "./renewalReceipt.grantFixture";
import { webSignInManifest } from "./homeFeatures";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

// A session saved by an earlier sign-in that signed decrypt on a whole encryption network is never carried by a lease,
// when the lease is first admitted and when it is later used to restore. The signed resources below are the ones the
// SDK itself derives from the sign-in manifest, so they have the shape a real saved session holds.

const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];
const ADDRESS = "0x00000000000000000000000000000000000000a1";

/** What a sign-in with this manifest signs for the encryption service: the SDK's own `rawAbilities`. */
function signedEncryption(manifest: Manifest): SignedResources {
  const authorization = new NodeUserAuthorization({
    manifest, includeAccountRegistryPermissions: false, domain: "tinycloud.chat", sessionManager: {}, wasmBindings: {},
  } as unknown as ConstructorParameters<typeof NodeUserAuthorization>[0]);
  const capabilities = (authorization as unknown as { resolveSignInCapabilities(address: string, chainId: number): { rawAbilities?: SignedResources } })
    .resolveSignInCapabilities(ADDRESS, 1);
  return capabilities.rawAbilities ?? {};
}

function storageOf(record: Awaited<ReturnType<typeof leasedSession>>["record"], address: string) {
  return {
    activeAddressForRenewal: () => address,
    loadRenewalCandidate: async () => ({ status: "renewal-candidate", data: record }),
  } as Parameters<typeof renewalRestoreFor>[1];
}

beforeEach(() => {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
});
afterEach(() => {
  if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag;
  Reflect.deleteProperty(globalThis, "localStorage");
});

const wholeNetwork = () => { delete buildEnv[BUILD_FLAG]; return signedEncryption(webSignInManifest(WEB_APP_MANIFEST, ["connectors"], ADDRESS)); };
const exactKeys = () => { buildEnv[BUILD_FLAG] = "true"; return signedEncryption(webSignInManifest(WEB_APP_MANIFEST, ["connectors"], ADDRESS)); };

describe("a lease for a saved session", () => {
  test("that signed decrypt on a whole encryption network is refused and its receipt dropped on restore", async () => {
    const signed = wholeNetwork();
    expect(Object.keys(signed).some((resource) => !resource.includes("/"))).toBe(true);
    const { owner, record, receipt } = await leasedSession(signed);
    saveRenewalReceipt(owner.address, receipt);
    expect(await verifiedRenewalLease(receipt, record)).toBeNull();
    expect(await renewalRestoreFor(owner.address, storageOf(record, owner.address))).toBeNull();
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });

  test("that signed only the exact connector keys is still used and its receipt kept", async () => {
    const signed = exactKeys();
    expect(Object.keys(signed).length).toBeGreaterThan(0);
    expect(Object.keys(signed).every((resource) => resource.includes("/"))).toBe(true);
    const { owner, record, receipt, lease } = await leasedSession(signed);
    saveRenewalReceipt(owner.address, receipt);
    expect(await verifiedRenewalLease(receipt, record)).toBe(lease.authorization);
    expect(await renewalRestoreFor(owner.address, storageOf(record, owner.address)))
      .toEqual({ address: owner.address, leaseAuthorization: lease.authorization });
    expect(loadRenewalReceipt(owner.address)).toEqual(receipt);
  });

  test("that signed a whole network is not admitted at sign-in: no node call, nothing kept", async () => {
    const { owner, record, receipt } = await leasedSession(wholeNetwork());
    let nodeAsked = 0;
    const kept = await admitSignInRenewal({
      tcw: { activeNodeIdentity: async () => { nodeAsked++; throw new Error("not reached"); } },
      address: owner.address,
      renewal: receipt,
      arrivedAt: performance.now(),
      storage: { load: async () => record },
    });
    expect(kept).toBe(false);
    expect(nodeAsked).toBe(0);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });
});
