import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { maybeStartGmeetSessionSync, resetGmeetSessionSyncForTests, type GmeetSessionSyncHooks } from "@/chat/useGmeetSessionSync";
import { initialBackgroundSyncState, queueNotices, applyIngestOutcome } from "@/chat/backgroundSyncState";
import { OLDER_KEYS_BLOCKED_DETAIL, OLDER_KEYS_BLOCKED_TITLE, OLDER_KEYS_SYNC_DECLINED } from "../homeStrings";
import type { SecretsResult } from "./connectorSecrets";
import { CONNECTORS } from "./registry";
import type { LegacyKeysOutcome } from "./legacyKeyReseal";
import { isOlderKeyError, readWithOlderKeysApproval, syncKeyReadMessage } from "./olderKeyRead";
import { ingestQueuedMeetings } from "./targetedSync";
import type { ConnectorDescriptor } from "./types";

const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];
const setFlag = (on: boolean) => { if (on) buildEnv[BUILD_FLAG] = "true"; else delete buildEnv[BUILD_FLAG]; };
beforeEach(() => setFlag(true));
afterEach(() => { if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag; });

const OLDER_KEY_CODES = ["DECRYPTION_FAILED", "DECRYPT_DENIED", "LEGACY_ENVELOPE"] as const;
type Err = { code?: string; message?: string };
const failure = (code: string): SecretsResult<string, Err> => ({ ok: false, error: { code, message: `sdk says ${code}` } });
const tcw = { session: () => ({ address: "0x00000000000000000000000000000000000000a1" }) } as unknown as TinyCloudWeb;

/** A read that answers `replies` in order and counts calls; an approval that answers `outcome` and counts prompts. */
function scenario(replies: SecretsResult<string, Err>[], outcome: LegacyKeysOutcome) {
  const counts = { reads: 0, prompts: 0 };
  const read = async () => replies[Math.min(counts.reads++, replies.length - 1)];
  const resolve = async () => { counts.prompts++; return outcome; };
  return { counts, read, resolve };
}

describe("isOlderKeyError", () => {
  test("the three older-key codes, and nothing else", () => {
    for (const code of OLDER_KEY_CODES) expect(isOlderKeyError({ code })).toBe(true);
    for (const code of ["NOT_FOUND", "VAULT_LOCKED", "KEY_NOT_FOUND", "AAD_MISMATCH", "constructor"]) expect(isOlderKeyError({ code })).toBe(false);
    expect(isOlderKeyError(null)).toBe(false);
    expect(isOlderKeyError({})).toBe(false);
  });
});

describe("readWithOlderKeysApproval (a Sync now press)", () => {
  for (const code of OLDER_KEY_CODES) {
    test(`${code}: asks the approval once, and "moved" reads once more and returns that read`, async () => {
      const s = scenario([failure(code), { ok: true, data: "key" }], "moved");
      expect(await readWithOlderKeysApproval(tcw, s.read, s.resolve)).toEqual({ ok: true, data: "key" });
      expect(s.counts).toEqual({ reads: 2, prompts: 1 });
    });

    test(`${code}: a retry that fails again is returned as it is, with no second prompt`, async () => {
      const s = scenario([failure(code), failure(code)], "moved");
      const result = await readWithOlderKeysApproval(tcw, s.read, s.resolve);
      expect(result).toEqual(failure(code));
      expect("olderKeys" in result).toBe(false);
      expect(s.counts).toEqual({ reads: 2, prompts: 1 });
    });

    for (const outcome of ["declined", "failed"] as const) {
      test(`${code}: "${outcome}" leaves the read alone, marks the failure and does not read or ask again`, async () => {
        const s = scenario([failure(code), { ok: true, data: "key" }], outcome);
        const result = await readWithOlderKeysApproval(tcw, s.read, s.resolve);
        expect(result).toMatchObject({ ok: false, olderKeys: outcome });
        expect(s.counts).toEqual({ reads: 1, prompts: 1 });
      });
    }

    test(`${code}: "nothing" (no older key found) keeps the plain failure`, async () => {
      const s = scenario([failure(code)], "nothing");
      expect(await readWithOlderKeysApproval(tcw, s.read, s.resolve)).toEqual(failure(code));
      expect(s.counts).toEqual({ reads: 1, prompts: 1 });
    });

    test(`${code}: with the flag off nothing is asked and the failure is unchanged`, async () => {
      setFlag(false);
      const s = scenario([failure(code)], "moved");
      expect(await readWithOlderKeysApproval(tcw, s.read, s.resolve)).toEqual(failure(code));
      expect(s.counts).toEqual({ reads: 1, prompts: 0 });
    });
  }

  test("any other failure is returned untouched and never asks", async () => {
    for (const code of ["NOT_FOUND", "VAULT_LOCKED", "NETWORK_ERROR"]) {
      const s = scenario([failure(code)], "moved");
      expect(await readWithOlderKeysApproval(tcw, s.read, s.resolve)).toEqual(failure(code));
      expect(s.counts).toEqual({ reads: 1, prompts: 0 });
    }
  });

  test("a success never asks, and an approval that throws counts as failed", async () => {
    const ok = scenario([{ ok: true, data: "key" }], "moved");
    expect(await readWithOlderKeysApproval(tcw, ok.read, ok.resolve)).toEqual({ ok: true, data: "key" });
    expect(ok.counts).toEqual({ reads: 1, prompts: 0 });
    const read = async () => failure("DECRYPT_DENIED");
    const thrown = await readWithOlderKeysApproval(tcw, read, async () => { throw new Error("popup closed"); });
    expect(thrown).toMatchObject({ ok: false, olderKeys: "failed" });
  });
});

describe("syncKeyReadMessage (the Connectors card row)", () => {
  const failed = (olderKeys?: "declined" | "failed", error: Err = { code: "DECRYPT_DENIED", message: "sdk says DECRYPT_DENIED" }) =>
    ({ ok: false as const, error, ...(olderKeys ? { olderKeys } : {}) });

  test("declined names the approval; failed shows the plain read failure; neither shows the SDK text", () => {
    expect(syncKeyReadMessage(failed("declined"), "fireflies")).toBe(OLDER_KEYS_SYNC_DECLINED);
    expect(OLDER_KEYS_SYNC_DECLINED).toContain("allow the one-hour approval");
    expect(syncKeyReadMessage(failed("failed"), "fireflies")).toBe("Could not read API key");
    expect(syncKeyReadMessage(failed("failed"), "gmeet")).toBe("Could not read the saved Google connection");
  });

  test("a failure no approval was asked about keeps its own message, then the plain read failure", () => {
    expect(syncKeyReadMessage(failed(undefined, { code: "NETWORK_ERROR", message: "offline" }), "fireflies")).toBe("offline");
    expect(syncKeyReadMessage(failed(undefined, {}), "gmeet")).toBe("Could not read the saved Google connection");
    expect(syncKeyReadMessage(failed(undefined, {}), "fireflies")).toBe("Could not read API key");
  });
});

describe("targeted ingest (never prompts)", () => {
  const fireflies = CONNECTORS.find((d) => d.id === "fireflies") as ConnectorDescriptor;
  const run = (error: Err) =>
    ingestQueuedMeetings({
      tcw: {} as TinyCloudWeb,
      descriptor: fireflies,
      items: [{ meetingId: "m1", kind: "transcript" }],
      webhooks: { acknowledge: async () => { throw new Error("must not ack"); } },
      secrets: { isUnlocked: () => true, getKey: async () => ({ ok: false, error }) },
    });

  for (const code of OLDER_KEY_CODES) {
    test(`${code} is blocked on the older-keys approval, with nothing fetched or acknowledged`, async () => {
      const res = await run({ code, message: "sdk text" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data).toMatchObject({ blocked: "older-keys", stored: 0, acknowledged: 0, failures: [] });
    });

    test(`${code} with the flag off is the failure it was`, async () => {
      setFlag(false);
      const res = await run({ code, message: "sdk text" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toStartWith("secrets.get:");
    });
  }

  test("any other code is not the older-keys state", async () => {
    const res = await run({ code: "SECRETS_BACKEND", message: "node down" });
    expect(res.ok).toBe(false);
  });

  test("the blocked state shows the approval notice and not the reconnect one", () => {
    const outcome = { stored: 0, inserted: 0, updated: 0, acknowledged: 0, alreadySettled: 0, tombstoned: 0, failures: [], unacknowledged: [], ackError: null, blocked: "older-keys" as const, itemCount: 0 };
    const state = applyIngestOutcome({ ...initialBackgroundSyncState(), phase: "enabled" }, outcome);
    expect(state.ingestBlocked).toBe("older-keys");
    expect(queueNotices(state)).toEqual([
      { kind: "ingest-blocked", title: OLDER_KEYS_BLOCKED_TITLE, detail: OLDER_KEYS_BLOCKED_DETAIL, action: null, tone: "warn" },
    ]);
    expect(OLDER_KEYS_BLOCKED_DETAIL).not.toMatch(/reconnect|connect again/i);
  });
});

describe("Google Meet session sync (the background lane never prompts)", () => {
  const gmeet = { ...(CONNECTORS.find((d) => d.id === "google-meet") as ConnectorDescriptor), status: "available" as const, secretName: "REFRESH_TOKEN" };
  const run = async (error: Err) => {
    resetGmeetSessionSyncForTests();
    let mints = 0;
    const hooks: GmeetSessionSyncHooks = {
      connectors: [gmeet],
      getConnection: async () => ({ ok: true, data: { connectorId: "google-meet", status: "connected", lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null, itemCount: 0 } }),
      isUnlocked: () => true,
      readRefreshToken: async () => ({ ok: false, error }),
      mintAccessToken: async () => (mints++, "token"),
    };
    const outcome = await maybeStartGmeetSessionSync({ tcw: {} as TinyCloudWeb, sessionStore: {} as never, backendUrl: "https://backend.example", hooks });
    return { outcome, mints };
  };

  for (const code of OLDER_KEY_CODES) {
    test(`${code} stops on the older-keys state, not the missing-token one`, async () => {
      expect(await run({ code })).toEqual({ outcome: "older-keys", mints: 0 });
    });
    test(`${code} with the flag off is the missing-token stop it was`, async () => {
      setFlag(false);
      expect((await run({ code })).outcome).toBe("no-refresh-token");
    });
  }

  test("any other code stays the missing-token stop", async () => {
    expect((await run({ code: "NOT_FOUND" })).outcome).toBe("no-refresh-token");
  });
});
