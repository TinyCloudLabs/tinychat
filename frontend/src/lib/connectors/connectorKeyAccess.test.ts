import { afterEach, beforeEach, expect, test } from "bun:test";
import type { connectWallet } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  askConnectorKeyAccess,
  CONNECTOR_KEY_ACCESS_MAX_MS,
  connectorKeyPermissions,
  connectorPausedMessage,
  isConnectorKeyAccessPaused,
  markConnectorKeyAccessPaused,
  resetConnectorKeyAccessForTests,
} from "./connectorKeyAccess";
import { CONNECTORS } from "./registry";

const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`;
const FIREFLIES = CONNECTORS.find((c) => c.id === "fireflies")!;
const GRANOLA = CONNECTORS.find((c) => c.id === "granola")!;
const MEET = CONNECTORS.find((c) => c.id === "google-meet")!;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-05-04T12:00:00Z");

function fixture(opts: { sessionLeftMs?: number; approved?: boolean; held?: boolean; connectAs?: string } = {}) {
  let held = opts.held ?? false;
  let sessionKey = "key-1";
  const requests: { permissions: unknown; options: { expiryMs: number } }[] = [];
  let connects = 0;
  const siwe = `Expiration Time: ${new Date(NOW + (opts.sessionLeftMs ?? 30 * DAY)).toISOString()}`;
  const tcw = {
    session: () => ({ address: ADDRESS, chainId: 1, sessionKey, siwe }),
    hasPermissions: () => held,
    setRuntimePermissionSigner: () => {},
    requestPermissions: async (permissions: unknown, options: { expiryMs: number }) => {
      requests.push({ permissions, options });
      held = opts.approved ?? true;
      return { approved: opts.approved ?? true };
    },
  } as unknown as TinyCloudWeb;
  const connect = (async () => {
    connects++;
    return { address: opts.connectAs ?? ADDRESS, openkey: { signMessage: async () => ({ signature: "fixture" }) } };
  }) as unknown as typeof connectWallet;
  return { tcw, connect, requests, connects: () => connects, rotateSession: () => (sessionKey = "key-2") };
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

test("one entry per connector: decrypt and key.create on its own key only, with Monica's wording", () => {
  expect(connectorKeyPermissions(ADDRESS, 1, [FIREFLIES, GRANOLA, MEET])).toEqual([
    {
      service: "tinycloud.encryption",
      path: `${NETWORK}/secrets/fireflies_api_key`,
      actions: ["decrypt", "key.create"],
      skipPrefix: true,
      description: "Lets TinyChat use your Fireflies key to bring in your meetings. Only this key, for up to 7 days.",
    },
    {
      service: "tinycloud.encryption",
      path: `${NETWORK}/secrets/${GRANOLA.secretName.toLowerCase()}`,
      actions: ["decrypt", "key.create"],
      skipPrefix: true,
      description: "Lets TinyChat use your Granola key to bring in your meetings. Only this key, for up to 7 days.",
    },
    {
      service: "tinycloud.encryption",
      path: `${NETWORK}/secrets/scoped/google-meet/refresh_token`,
      actions: ["decrypt", "key.create"],
      skipPrefix: true,
      description:
        "Lets TinyChat use your Google Meet connection to bring in your meetings. Only this connection, for up to 7 days.",
    },
  ]);
});

test("asks once for every connector, for 7 days less 5 minutes when the session lasts longer", async () => {
  const f = fixture();
  expect(await askConnectorKeyAccess(f.tcw, [FIREFLIES, MEET], { connect: f.connect, now: () => NOW })).toBe("granted");
  expect(f.requests).toEqual([
    { permissions: connectorKeyPermissions(ADDRESS, 1, [FIREFLIES, MEET]), options: { expiryMs: CONNECTOR_KEY_ACCESS_MAX_MS } },
  ]);
  expect(CONNECTOR_KEY_ACCESS_MAX_MS).toBe(7 * DAY - 5 * 60_000);
});

test("never outlasts the session", async () => {
  const f = fixture({ sessionLeftMs: 2 * HOUR });
  await askConnectorKeyAccess(f.tcw, [FIREFLIES], { connect: f.connect, now: () => NOW });
  expect(f.requests[0]!.options.expiryMs).toBe(2 * HOUR);
});

test("access the session already holds asks nothing", async () => {
  const f = fixture({ held: true });
  expect(await askConnectorKeyAccess(f.tcw, [FIREFLIES], { connect: f.connect, now: () => NOW })).toBe("granted");
  expect(f.connects()).toBe(0);
  expect(f.requests).toEqual([]);
});

test("a declined approval, another account, or an ended session is never granted", async () => {
  const declined = fixture({ approved: false });
  expect(await askConnectorKeyAccess(declined.tcw, [FIREFLIES], { connect: declined.connect, now: () => NOW })).toBe("declined");

  const other = fixture({ connectAs: "0x" + "22".repeat(20) });
  expect(await askConnectorKeyAccess(other.tcw, [FIREFLIES], { connect: other.connect, now: () => NOW })).toBe("session-changed");
  expect(other.requests).toEqual([]);

  const ended = fixture({ sessionLeftMs: -1 });
  expect(await askConnectorKeyAccess(ended.tcw, [FIREFLIES], { connect: ended.connect, now: () => NOW })).toBe("session-expired");
  expect(ended.requests).toEqual([]);
});

test("a paused connector says access ended once an approval has run out, and that it's needed otherwise", async () => {
  const f = fixture();
  markConnectorKeyAccessPaused(f.tcw, "fireflies");
  expect(isConnectorKeyAccessPaused(ADDRESS, "fireflies")).toBe(true);
  expect(connectorPausedMessage(ADDRESS, FIREFLIES, NOW)).toBe(
    "Paused. Approve TinyChat's access to keep your Fireflies meetings coming in.",
  );

  await askConnectorKeyAccess(f.tcw, [FIREFLIES], { connect: f.connect, now: () => NOW });
  expect(isConnectorKeyAccessPaused(ADDRESS, "fireflies")).toBe(false);

  // Another tab reads the record from localStorage: still running, then ended.
  resetConnectorKeyAccessForTests();
  expect(connectorPausedMessage(ADDRESS, FIREFLIES, NOW + DAY)).toBe(
    "Paused. Approve TinyChat's access to keep your Fireflies meetings coming in.",
  );
  const ended = new Date(NOW + CONNECTOR_KEY_ACCESS_MAX_MS).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  expect(connectorPausedMessage(ADDRESS, FIREFLIES, NOW + 8 * DAY)).toBe(`Paused since ${ended}. TinyChat's access to Fireflies ended.`);
  expect(connectorPausedMessage(ADDRESS, MEET, NOW + 8 * DAY)).toBe(
    "Paused. Approve TinyChat's access to keep your Google Meet meetings coming in.",
  );
});
