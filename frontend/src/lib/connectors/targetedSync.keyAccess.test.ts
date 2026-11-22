// A background run whose key needs the owner's approval pauses the connector and never asks (TC-3804).
import { beforeEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { isConnectorKeyAccessPaused, resetConnectorKeyAccessForTests } from "./connectorKeyAccess";
import { CONNECTORS } from "./registry";
import { ingestQueuedMeetings, type TargetedAckClient, type TargetedIngestStore } from "./targetedSync";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const fireflies = CONNECTORS.find((d) => d.id === "fireflies")!;

beforeEach(() => resetConnectorKeyAccessForTests());

test("DECRYPT_DENIED pauses the row and touches nothing else", async () => {
  const touched: string[] = [];
  const tcw = {
    session: () => ({ address: OWNER, chainId: 1 }),
    requestPermissions: async () => (touched.push("requestPermissions"), { approved: true }),
  } as unknown as TinyCloudWeb;
  const never = (name: string) => async () => {
    touched.push(name);
    throw new Error(`${name} must not run`);
  };
  const res = await ingestQueuedMeetings({
    tcw,
    descriptor: fireflies,
    items: [{ meetingId: "m1", kind: "transcript" }],
    webhooks: { acknowledge: never("acknowledge") } as unknown as TargetedAckClient,
    store: {
      upsertMeeting: never("upsertMeeting"),
      updateSyncState: never("updateSyncState"),
      countMeetings: never("countMeetings"),
    } as unknown as TargetedIngestStore,
    secrets: {
      isUnlocked: () => true,
      getKey: async () => ({ ok: false, error: { code: "DECRYPT_DENIED", message: "not granted" } }),
    },
    createClient: () => {
      touched.push("createClient");
      throw new Error("createClient must not run");
    },
  });

  expect(res.ok && res.data.blocked).toBe("key-access");
  expect(isConnectorKeyAccessPaused(OWNER, "fireflies")).toBe(true);
  expect(touched).toEqual([]);
});
