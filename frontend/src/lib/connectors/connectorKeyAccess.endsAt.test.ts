import { afterEach, beforeEach, expect, test } from "bun:test";
import type { connectWallet } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  askConnectorKeyAccess,
  CONNECTOR_KEY_ACCESS_MAX_MS,
  connectorKeyAccessEndsAt,
  resetConnectorKeyAccessForTests,
} from "./connectorKeyAccess";
import { CONNECTORS } from "./registry";

// TC-3804: the recorded end (which bounds the in-memory key cache) never outlives the grant, however long the
// owner takes to approve in OpenKey. The node starts the grant at approval and clamps it to the session.
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const FIREFLIES = CONNECTORS.find((c) => c.id === "fireflies")!;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse("2026-05-04T12:00:00Z");

function slowApproval(sessionLeftMs: number, approvalTakesMs: number) {
  let clock = NOW;
  let held = false;
  let grantEnd = Number.NaN;
  const sessionEnd = NOW + sessionLeftMs;
  const tcw = {
    session: () => ({ address: ADDRESS, chainId: 1, sessionKey: "key-1", siwe: `Expiration Time: ${new Date(sessionEnd).toISOString()}` }),
    hasPermissions: () => held,
    setRuntimePermissionSigner: () => {},
    requestPermissions: async (_permissions: unknown, options: { expiryMs: number }) => {
      clock += approvalTakesMs;
      grantEnd = Math.min(clock + options.expiryMs, sessionEnd);
      held = true;
      return { approved: true };
    },
  } as unknown as TinyCloudWeb;
  const connect = (async () => ({
    address: ADDRESS,
    openkey: { signMessage: async () => ({ signature: "fixture" }) },
  })) as unknown as typeof connectWallet;
  return { tcw, connect, now: () => clock, grantEnd: () => grantEnd };
}

beforeEach(() => {
  resetConnectorKeyAccessForTests();
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("a slow approval never records an end past the grant's", async () => {
  const f = slowApproval(30 * DAY, 10 * MINUTE);
  expect(await askConnectorKeyAccess(f.tcw, [FIREFLIES], { connect: f.connect, now: f.now })).toBe("granted");
  const endsAt = connectorKeyAccessEndsAt(ADDRESS, "fireflies")!;
  expect(endsAt).toBeLessThanOrEqual(f.grantEnd());
  expect(endsAt).toBe(NOW + CONNECTOR_KEY_ACCESS_MAX_MS);
});

test("a slow approval near the session's end never records an end past the grant's", async () => {
  const f = slowApproval(2 * 60 * MINUTE, 10 * MINUTE);
  expect(await askConnectorKeyAccess(f.tcw, [FIREFLIES], { connect: f.connect, now: f.now })).toBe("granted");
  expect(connectorKeyAccessEndsAt(ADDRESS, "fireflies")!).toBeLessThanOrEqual(f.grantEnd());
});
