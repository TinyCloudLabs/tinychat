// A background run whose key needs the owner's approval, or whose copy is still sealed to the network key, pauses the
// connector: it never asks, never reseals, never writes a secret and never reads one without `namedKeyOnly` (TC-3804).
import { beforeEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { isConnectorKeyAccessPaused, resetConnectorKeyAccessForTests } from "./connectorKeyAccess";
import { getConnectorKey, resetVaultSecretCacheForTests } from "./connectorSecrets";
import { CONNECTORS } from "./registry";
import { ingestQueuedMeetings, type TargetedAckClient, type TargetedIngestStore } from "./targetedSync";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const fireflies = CONNECTORS.find((d) => d.id === "fireflies")!;

beforeEach(() => {
  resetConnectorKeyAccessForTests();
  resetVaultSecretCacheForTests();
});

/** A vault holding a network-sealed (v1) copy: only a read without `namedKeyOnly` would open it. */
function v1Vault(namedKeyOnlyError: { code: string; message: string }) {
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
        return options?.namedKeyOnly ? { ok: false, error: namedKeyOnlyError } : { ok: true, data: "v1-network-opened" };
      },
      put: async () => (touched.push("put"), { ok: true }),
      delete: async () => (touched.push("delete"), { ok: true }),
      list: async () => (touched.push("list"), { ok: true, data: [] }),
      vault: { resealToKey: async () => (touched.push("resealToKey"), { status: "moved" }) },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, touched, gets };
}

for (const error of [
  { code: "LEGACY_ENVELOPE", message: "Envelope is sealed to the network key, not this record's own key" },
  { code: "DECRYPT_DENIED", message: "not granted" },
]) {
  test(`${error.code}: a background ingest pauses and only ever reads namedKeyOnly`, async () => {
    const { tcw, touched, gets } = v1Vault(error);
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
      // The production read, behind the production unlock check's stand-in.
      secrets: { isUnlocked: () => true, getKey: (t, d) => getConnectorKey<unknown>(t, d) },
      createClient: () => {
        touched.push("createClient");
        throw new Error("createClient must not run");
      },
    });

    expect(res.ok && res.data.blocked).toBe("key-access");
    expect(isConnectorKeyAccessPaused(OWNER, "fireflies")).toBe(true);
    expect(gets).toEqual([{ namedKeyOnly: true }]);
    expect(touched).toEqual([]);
  });
}
