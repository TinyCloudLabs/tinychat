import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { OLDER_KEYS_SYNC_DECLINED } from "@/lib/homeStrings";
import type { LegacyKeysOutcome } from "@/lib/connectors/legacyKeyReseal";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorDescriptor } from "@/lib/connectors/types";
import { SOURCE_SYNC_FAILED_MESSAGE, runSourceSync, type SourceSyncDeps } from "./useSourceSync";

const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];
const setFlag = (on: boolean) => { if (on) buildEnv[BUILD_FLAG] = "true"; else delete buildEnv[BUILD_FLAG]; };
beforeEach(() => setFlag(true));
afterEach(() => { if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag; });

const fireflies = CONNECTORS.find((d) => d.id === "fireflies") as ConnectorDescriptor;
const gmeet = CONNECTORS.find((d) => d.id === "google-meet") as ConnectorDescriptor;
const RECONNECT = "TinyCloud One can't read your saved Fireflies connection. Disconnect it under Manage, then connect Fireflies again.";
const CODES = ["DECRYPTION_FAILED", "DECRYPT_DENIED", "LEGACY_ENVELOPE"];

function run(d: ConnectorDescriptor, code: string, reads: { calls: number }, retry: "ok" | "fail" = "ok", engineRuns = { n: 0 }) {
  const deps: SourceSyncDeps = {
    secretsAvailable: () => true,
    isSecretsUnlocked: () => true,
    unlockSecrets: (async () => ({ ok: true, data: undefined })) as SourceSyncDeps["unlockSecrets"],
    getConnectorKey: (async () => {
      reads.calls++;
      return reads.calls === 1 || retry === "fail" ? { ok: false, error: { code, message: "sdk text" } } : { ok: true, data: "key" };
    }) as SourceSyncDeps["getConnectorKey"],
    isGmeetSyncInFlight: () => false,
    isGmeetNotesSyncInFlight: () => false,
    awaitSessionSync: async () => {},
    runGmeetSyncNow: async () => (engineRuns.n++, { ok: true }),
    runFirefliesSyncNow: async () => (engineRuns.n++, { ok: true }),
    runGranolaSyncNow: async () => (engineRuns.n++, { ok: true }),
  };
  return deps;
}

const input = (tcw: TinyCloudWeb) => ({ tcw, backendUrl: "https://x.test", sessionStore: {} as SessionStore });

describe("Sync now on a connection saved under an older key", () => {
  for (const code of CODES) {
    test(`${code} with no older key to move keeps the reconnect sentence (and asks nothing)`, async () => {
      const reads = { calls: 0 };
      const probeNothing = { session: () => ({ address: "0xa1" }), secrets: { vault: { resealToKey: async () => ({ status: "already" }) } } } as unknown as TinyCloudWeb;
      expect(await runSourceSync(fireflies, input(probeNothing), run(fireflies, code, reads))).toBe(code === "DECRYPTION_FAILED" ? RECONNECT : "sdk text");
      expect(reads.calls).toBe(1);
    });

    test(`${code} with the flag off keeps today's message and never touches the vault`, async () => {
      setFlag(false);
      const reads = { calls: 0 };
      const message = await runSourceSync(fireflies, input({} as TinyCloudWeb), run(fireflies, code, reads));
      expect(message).toBe(code === "DECRYPTION_FAILED" ? RECONNECT : "sdk text");
      expect(reads.calls).toBe(1);
    });
  }

  test("a code that is not an older-key code keeps its own message", async () => {
    const reads = { calls: 0 };
    expect(await runSourceSync(fireflies, input({} as TinyCloudWeb), run(fireflies, "NETWORK_ERROR", reads))).toBe("sdk text");
    expect(reads.calls).toBe(1);
  });
});

describe("Sync now with an older key found", () => {
  const tcw = { session: () => ({ address: "0x00000000000000000000000000000000000000a1" }) } as unknown as TinyCloudWeb;
  const approval = (outcome: LegacyKeysOutcome, prompts = { n: 0 }) => ({
    prompts,
    resolveOlderKeys: async () => (prompts.n++, outcome),
  });

  for (const code of CODES) {
    for (const [outcome, expected] of [["declined", OLDER_KEYS_SYNC_DECLINED], ["failed", SOURCE_SYNC_FAILED_MESSAGE]] as const) {
      for (const d of [fireflies, gmeet]) {
        test(`${code} on ${d.id}: "${outcome}" shows ${outcome === "declined" ? "the approval message" : "the generic failure"}, never the reconnect sentence, and asks and reads once`, async () => {
          const reads = { calls: 0 };
          const engines = { n: 0 };
          const a = approval(outcome);
          const message = await runSourceSync(d, input(tcw), { ...run(d, code, reads, "ok", engines), resolveOlderKeys: a.resolveOlderKeys });
          expect(message).toBe(expected);
          expect(message).not.toBe(RECONNECT);
          expect(reads.calls).toBe(1);
          expect(a.prompts.n).toBe(1);
          expect(engines.n).toBe(0);
        });
      }
    }

    test(`${code}: "moved" reads once more and the sync goes ahead`, async () => {
      const reads = { calls: 0 };
      const engines = { n: 0 };
      const a = approval("moved");
      const message = await runSourceSync(fireflies, input(tcw), { ...run(fireflies, code, reads, "ok", engines), resolveOlderKeys: a.resolveOlderKeys });
      expect(message).toBeNull();
      expect(reads.calls).toBe(2);
      expect(a.prompts.n).toBe(1);
      expect(engines.n).toBe(1);
    });

    test(`${code}: "moved" and a read that still fails does not ask again`, async () => {
      const reads = { calls: 0 };
      const a = approval("moved");
      const message = await runSourceSync(fireflies, input(tcw), { ...run(fireflies, code, reads, "fail"), resolveOlderKeys: a.resolveOlderKeys });
      expect(message).toBe(code === "DECRYPTION_FAILED" ? RECONNECT : "sdk text");
      expect(reads.calls).toBe(2);
      expect(a.prompts.n).toBe(1);
    });
  }
});
