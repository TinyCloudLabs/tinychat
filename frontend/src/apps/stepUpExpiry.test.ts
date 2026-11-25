import { describe, expect, test } from "bun:test";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";

import { stepUpForApp, type StepUpConnect } from "./stepUp";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const PERMISSIONS: PermissionEntry[] = [{ service: "tinycloud.encryption", path: "urn:x", skipPrefix: true, actions: ["network.create"] }];

function fakes(hoursLeft: number) {
  const requested: { expiryMs?: number }[] = [];
  const siwe = `Expiration Time: ${new Date(Date.now() + hoursLeft * 3_600_000).toISOString()}`;
  const tcw = {
    session: () => ({ address: ADDRESS, chainId: 1, sessionKey: "k", siwe }),
    setRuntimePermissionSigner: () => {},
    requestPermissions: async (_: PermissionEntry[], options: { expiryMs?: number }) => { requested.push(options); return { approved: true }; },
    hasPermissions: () => true,
  } as unknown as TinyCloudWeb;
  const connect: StepUpConnect = async () => ({ address: ADDRESS, openkey: { signMessage: async () => ({ signature: "0x00" }) } });
  return { tcw, connect, requested };
}

describe("stepUpForApp lifetime", () => {
  test("a cap shorter than the rest of the session shortens the grant to the cap", async () => {
    const { tcw, connect, requested } = fakes(24);
    expect(await stepUpForApp(tcw, PERMISSIONS, connect, { maxExpiryMs: 3_600_000 })).toBe(true);
    expect(requested).toEqual([{ expiryMs: 3_600_000 }]);
  });

  test("a cap longer than the rest of the session leaves the session's end", async () => {
    const { tcw, connect, requested } = fakes(0.5);
    await stepUpForApp(tcw, PERMISSIONS, connect, { maxExpiryMs: 3_600_000 });
    expect(requested[0].expiryMs).toBeLessThanOrEqual(1_800_000);
    expect(requested[0].expiryMs).toBeGreaterThan(1_700_000);
  });

  test("with no cap the grant runs to the session's end, as before", async () => {
    const { tcw, connect, requested } = fakes(24);
    await stepUpForApp(tcw, PERMISSIONS, connect);
    expect(requested[0].expiryMs).toBeGreaterThan(23 * 3_600_000);
  });
});
