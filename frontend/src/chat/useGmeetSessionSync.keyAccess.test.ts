// The session-start Meet sync never asks OpenKey and never reseals: a refresh token whose key needs approval, or whose
// copy is still sealed to the network key, pauses the row; it only ever reads `namedKeyOnly` (TC-3804).
import { beforeEach, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { isConnectorKeyAccessPaused, resetConnectorKeyAccessForTests } from "@/lib/connectors/connectorKeyAccess";
import { resetVaultSecretCacheForTests } from "@/lib/connectors/connectorSecrets";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorConnection, ConnectorDescriptor } from "@/lib/connectors/types";
import { maybeStartGmeetSessionSync, resetGmeetSessionSyncForTests } from "./useGmeetSessionSync";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const meet = { ...CONNECTORS.find((d) => d.id === "google-meet")!, status: "available" } as ConnectorDescriptor;

beforeEach(() => {
  resetGmeetSessionSyncForTests();
  resetConnectorKeyAccessForTests();
  resetVaultSecretCacheForTests();
});

for (const error of [
  { code: "LEGACY_ENVELOPE", message: "Envelope is sealed to the network key, not this record's own key" },
  { code: "DECRYPT_DENIED", message: "not granted" },
]) {
  test(`${error.code}: pauses Meet without asking, resealing, writing, minting or syncing`, async () => {
    const touched: string[] = [];
    const gets: unknown[] = [];
    const tcw = {
      did: "did:example:owner",
      session: () => ({ address: OWNER, chainId: 1 }),
      requestPermissions: async () => (touched.push("requestPermissions"), { approved: true }),
      secrets: {
        isUnlocked: true,
        get: async (_name: string, options?: { namedKeyOnly?: boolean }) => {
          gets.push(options);
          return options?.namedKeyOnly ? { ok: false, error } : { ok: true, data: "v1-network-opened" };
        },
        put: async () => (touched.push("put"), { ok: true }),
        delete: async () => (touched.push("delete"), { ok: true }),
        list: async () => (touched.push("list"), { ok: true, data: [] }),
        vault: { resealToKey: async () => (touched.push("resealToKey"), { status: "moved" }) },
      },
    } as unknown as TinyCloudWeb;
    const outcome = await maybeStartGmeetSessionSync({
      tcw,
      sessionStore: {} as SessionStore,
      backendUrl: "https://backend.test",
      hooks: {
        connectors: [meet],
        getConnection: async () => ({ ok: true, data: { status: "connected" } as ConnectorConnection }),
        isUnlocked: () => true,
        mintAccessToken: async () => (touched.push("mint"), "access"),
        runSync: async () => {
          touched.push("runSync");
          throw new Error("runSync must not run");
        },
      },
    });

    expect(outcome).toBe("key-access-paused");
    expect(isConnectorKeyAccessPaused(OWNER, "google-meet")).toBe(true);
    expect(gets).toEqual([{ scope: "google-meet", namedKeyOnly: true }]);
    expect(touched).toEqual([]);
  });
}
