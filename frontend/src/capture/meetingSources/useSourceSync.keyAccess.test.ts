// Sync now on a connector whose key needs the owner's approval (TC-3804): one ask, one more read; an old
// network-sealed copy is resealed to its own key first, and a failed reseal pauses the row.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { isConnectorKeyAccessPaused, resetConnectorKeyAccessForTests } from "@/lib/connectors/connectorKeyAccess";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorDescriptor } from "@/lib/connectors/types";
import { runSourceSync, type SourceSyncDeps } from "./useSourceSync";

const fireflies = CONNECTORS.find((d) => d.id === "fireflies") as ConnectorDescriptor;
const tcw = { session: () => ({ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", chainId: 1 }) } as unknown as TinyCloudWeb;
const input = { tcw, backendUrl: "https://x.test", sessionStore: {} as SessionStore };
const denied = { ok: false, error: { code: "DECRYPT_DENIED", message: "not granted" } };
const legacy = { ok: false, error: { code: "LEGACY_ENVELOPE", message: "sealed to the network key" } };
const PAUSED = "Paused. Approve TinyChat's access to keep your Fireflies meetings coming in.";

function run(reads: unknown[], access: "granted" | "declined", resealed = true) {
  const calls = { reads: 0, asks: 0, reseals: 0, engine: [] as string[] };
  const deps: SourceSyncDeps = {
    secretsAvailable: () => true,
    isSecretsUnlocked: () => true,
    unlockSecrets: (async () => ({ ok: true, data: undefined })) as SourceSyncDeps["unlockSecrets"],
    getConnectorKey: (async () => reads[Math.min(calls.reads++, reads.length - 1)]) as SourceSyncDeps["getConnectorKey"],
    askConnectorKeyAccess: async () => (calls.asks++, access),
    resealConnectorKey: async () => (calls.reseals++, resealed),
    isGmeetSyncInFlight: () => false,
    isGmeetNotesSyncInFlight: () => false,
    awaitSessionSync: async () => {},
    runGmeetSyncNow: async () => ({ ok: true }),
    runFirefliesSyncNow: async ({ apiKey }) => (calls.engine.push(apiKey), { ok: true }),
    runGranolaSyncNow: async () => ({ ok: true }),
  };
  return { calls, result: runSourceSync(fireflies, input, deps) };
}

beforeEach(() => {
  resetConnectorKeyAccessForTests();
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) },
  });
});
afterEach(() => Reflect.deleteProperty(globalThis, "localStorage"));

describe("Sync now with a key that needs approval", () => {
  test("asks once, reads again and syncs with the key", async () => {
    const { calls, result } = run([denied, { ok: true, data: "ff-key" }], "granted");
    expect(await result).toBeNull();
    expect(calls).toEqual({ reads: 2, asks: 1, reseals: 0, engine: ["ff-key"] });
  });

  test("a declined approval leaves the row paused and syncs nothing", async () => {
    const { calls, result } = run([denied], "declined");
    expect(await result).toBe(PAUSED);
    expect(calls).toEqual({ reads: 1, asks: 1, reseals: 0, engine: [] });
  });

  test("still denied after approval: no second ask", async () => {
    const { calls, result } = run([denied], "granted");
    expect(await result).toBe(PAUSED);
    expect(calls).toEqual({ reads: 2, asks: 1, reseals: 0, engine: [] });
  });
});

describe("Sync now with a copy still sealed to the network key", () => {
  test("approved key: reseals once, reads again and syncs with the key", async () => {
    const { calls, result } = run([legacy, { ok: true, data: "ff-key" }], "granted");
    expect(await result).toBeNull();
    expect(calls).toEqual({ reads: 2, asks: 0, reseals: 1, engine: ["ff-key"] });
  });

  test("needs approval first: asks, finds the old copy, reseals, syncs", async () => {
    const { calls, result } = run([denied, legacy, { ok: true, data: "ff-key" }], "granted");
    expect(await result).toBeNull();
    expect(calls).toEqual({ reads: 3, asks: 1, reseals: 1, engine: ["ff-key"] });
  });

  test("a failed reseal keeps the old copy, pauses the row and syncs nothing", async () => {
    const { calls, result } = run([legacy], "granted", false);
    expect(await result).toBe(PAUSED);
    expect(calls).toEqual({ reads: 1, asks: 0, reseals: 1, engine: [] });
    expect(isConnectorKeyAccessPaused("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "fireflies")).toBe(true);
  });
});
