// DECRYPT_DENIED is not only an older key's code: a record already on its own key can be denied too (a session that lacks
// that key's grant). The older-keys approval must open only when a record is really on the whole network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { readWithOlderKeysApproval } from "./olderKeyRead";
import { resolveLegacyConnectorKeys } from "./legacyKeyReseal";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];
beforeEach(() => { buildEnv[BUILD_FLAG] = "true"; });
afterEach(() => { if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag; });

type Probe = "pending" | "already" | "not_found" | "throws";
function sessioned(probe: Probe) {
  const asked: unknown[] = [];
  const tcw = {
    secrets: {
      vault: {
        resealToKey: async () => {
          if (probe === "throws") throw new Error("sdk");
          return probe === "not_found" ? { status: "skipped", reason: "not_found" } : { status: probe };
        },
      },
    },
    kv: { put: async () => ({ ok: true }) },
    session: () => ({ address: ADDRESS, chainId: 1, sessionKey: "k", siwe: `Expiration Time: ${new Date(Date.now() + 90 * 86_400_000).toISOString()}` }),
    setRuntimePermissionSigner: () => undefined,
    requestPermissions: async (permissions: unknown) => { asked.push(permissions); return { approved: false }; },
    hasPermissions: () => false,
  } as unknown as TinyCloudWeb;
  return { tcw, asked };
}

// The wallet the approval would sign with: reaching it at all means the approval screen is on its way.
function resolverWith(connected: { count: number }) {
  return (tcw: TinyCloudWeb, address: string) =>
    resolveLegacyConnectorKeys(tcw, address, async () => { connected.count++; return { address, openkey: { signMessage: async () => ({ signature: "0x" }) } } as never; });
}

const DENIED = { ok: false as const, error: { code: "DECRYPT_DENIED", message: "denied" } };

describe("a DECRYPT_DENIED read opens the older-keys approval only when a record is on the whole network", () => {
  test.each<Probe>(["already", "not_found"])("every record %s: the first failure comes back unchanged and nothing is asked", async (probe) => {
    const { tcw, asked } = sessioned(probe);
    const connected = { count: 0 };
    let reads = 0;
    const result = await readWithOlderKeysApproval(tcw, async () => { reads++; return DENIED; }, resolverWith(connected));
    expect(result).toBe(DENIED as never);
    expect("olderKeys" in result).toBe(false);
    expect(connected.count).toBe(0);
    expect(asked).toEqual([]);
    expect(reads).toBe(1);
  });

  test("a probe that cannot tell asks nothing either and reports the read failure", async () => {
    const { tcw, asked } = sessioned("throws");
    const connected = { count: 0 };
    const result = await readWithOlderKeysApproval(tcw, async () => DENIED, resolverWith(connected));
    expect(result).toEqual({ ok: false, error: DENIED.error, olderKeys: "failed" });
    expect(connected.count).toBe(0);
    expect(asked).toEqual([]);
  });

  test("with a record on the whole network the approval is asked (once), so the cases above are not vacuous", async () => {
    const { tcw, asked } = sessioned("pending");
    const connected = { count: 0 };
    const result = await readWithOlderKeysApproval(tcw, async () => DENIED, resolverWith(connected));
    expect(result).toEqual({ ok: false, error: DENIED.error, olderKeys: "declined" });
    expect(connected.count).toBe(1);
    expect(asked).toHaveLength(1);
  });
});
