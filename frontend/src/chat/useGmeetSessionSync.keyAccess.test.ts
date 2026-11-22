// The session-start Meet sync never asks OpenKey: a token whose key needs approval pauses the row (TC-3804).
import { beforeEach, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { isConnectorKeyAccessPaused, resetConnectorKeyAccessForTests } from "@/lib/connectors/connectorKeyAccess";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorConnection, ConnectorDescriptor } from "@/lib/connectors/types";
import { maybeStartGmeetSessionSync, resetGmeetSessionSyncForTests } from "./useGmeetSessionSync";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const meet = { ...CONNECTORS.find((d) => d.id === "google-meet")!, status: "available" } as ConnectorDescriptor;

beforeEach(() => {
  resetGmeetSessionSyncForTests();
  resetConnectorKeyAccessForTests();
});

test("DECRYPT_DENIED on the refresh token pauses Meet without asking, minting or syncing", async () => {
  const touched: string[] = [];
  const tcw = {
    session: () => ({ address: OWNER, chainId: 1 }),
    requestPermissions: async () => (touched.push("requestPermissions"), { approved: true }),
  } as unknown as TinyCloudWeb;
  const outcome = await maybeStartGmeetSessionSync({
    tcw,
    sessionStore: {} as SessionStore,
    backendUrl: "https://backend.test",
    hooks: {
      connectors: [meet],
      getConnection: async () => ({ ok: true, data: { status: "connected" } as ConnectorConnection }),
      isUnlocked: () => true,
      readRefreshToken: async () => ({ ok: false, error: { code: "DECRYPT_DENIED", message: "not granted" } }),
      mintAccessToken: async () => (touched.push("mint"), "access"),
      runSync: async () => {
        touched.push("runSync");
        throw new Error("runSync must not run");
      },
    },
  });

  expect(outcome).toBe("key-access-paused");
  expect(isConnectorKeyAccessPaused(OWNER, "google-meet")).toBe(true);
  expect(touched).toEqual([]);
});
