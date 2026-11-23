import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveRenewalReceipt } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { renewedSessionEndMs } from "../renewalReceipt";
import { leasedSession } from "../renewalReceipt.grantFixture";
import { LEGACY_NETWORK_APPROVAL_MAX_MS, legacyNetworkDecryptRequest } from "./encryptionGrant";
import { resolveLegacyConnectorKeys } from "./legacyKeyReseal";

// A session on its lease (day 8 of a 7-day signed session): the older-keys step still probes and asks, measured from
// the session's current end and not from the first signed end.

const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];
const DAY = 86_400_000;

beforeEach(() => {
  buildEnv[BUILD_FLAG] = "true";
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

/** A saved session on day 8: signed to expire a day ago, on its lease, the node reporting it ends in `endsInDays`. */
async function dayEightSession(endsInDays: number | "unknown") {
  const { owner, receipt } = await leasedSession({ "urn:cid:unused": ["tinycloud.kv/get"] });
  saveRenewalReceipt(owner.address, receipt);
  const asked: { permissions: unknown; expiryMs: number }[] = [];
  const probes = { count: 0 };
  const tcw = {
    secrets: {
      vault: { resealToKey: async (_key: string, _path: string, options?: { dryRun?: boolean }) => { if (options?.dryRun) probes.count++; return { status: "pending" }; } },
      get: async () => ({ ok: true, data: "value" }),
    },
    kv: { put: async () => ({ ok: true }) },
    session: () => ({ address: owner.address, chainId: 1, sessionKey: "k", siwe: `Expiration Time: ${new Date(Date.now() - DAY).toISOString()}` }),
    setRuntimePermissionSigner: () => {},
    getRenewalEffectiveExpiry: async () => {
      if (endsInDays === "unknown") throw new Error("node unreachable");
      return Math.floor((Date.now() + endsInDays * DAY) / 1000);
    },
    requestPermissions: async (permissions: unknown, options: { expiryMs: number }) => { asked.push({ permissions, expiryMs: options.expiryMs }); return { approved: false }; },
    hasPermissions: () => false,
  } as unknown as TinyCloudWeb;
  const connect = async () => ({ address: owner.address, openkey: { signMessage: async () => ({ signature: "0x" }) } }) as never;
  return { owner, tcw, asked, probes, connect };
}

describe("the older-keys step on a leased session past its first signed end", () => {
  test("still probes and asks, for at most the hour", async () => {
    const { owner, tcw, asked, probes, connect } = await dayEightSession(5);
    expect(await resolveLegacyConnectorKeys(tcw, owner.address, connect)).toBe("declined");
    expect(probes.count).toBeGreaterThan(0);
    expect(asked).toHaveLength(1);
    expect(asked[0].permissions).toEqual(legacyNetworkDecryptRequest(owner.address));
    expect(asked[0].expiryMs).toBe(LEGACY_NETWORK_APPROVAL_MAX_MS);
  });

  test("asks for no more than the session has left when that is under the hour", async () => {
    const { owner, tcw, asked, connect } = await dayEightSession(0.5 / 24);
    await resolveLegacyConnectorKeys(tcw, owner.address, connect);
    expect(asked).toHaveLength(1);
    expect(asked[0].expiryMs).toBeLessThan(LEGACY_NETWORK_APPROVAL_MAX_MS);
    expect(asked[0].expiryMs).toBeGreaterThan(0);
  });

  test("does not ask when the node cannot say how long the session lasts", async () => {
    const { owner, tcw, asked, connect } = await dayEightSession("unknown");
    expect(await resolveLegacyConnectorKeys(tcw, owner.address, connect)).toBe("declined");
    expect(asked).toHaveLength(0);
  });

  test("renewedSessionEndMs reads the node's end in ms, and nothing without a saved lease", async () => {
    const { owner, tcw } = await dayEightSession(3);
    const end = await renewedSessionEndMs(tcw, owner.address);
    expect(Math.abs((end ?? 0) - (Date.now() + 3 * DAY))).toBeLessThan(5_000);
    expect(await renewedSessionEndMs(tcw, "0x00000000000000000000000000000000000000b2")).toBeNull();
  });
});
