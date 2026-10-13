import { describe, expect, spyOn, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { ConnectorDescriptor } from "@/lib/connectors/types";
import { CONNECTORS } from "@/lib/connectors/registry";
import {
  FULL_RESCAN_BUSY_MESSAGE,
  SOURCE_SYNC_FAILED_MESSAGE,
  runSourceSync,
  syncProgressLabel,
  type SourceSyncDeps,
} from "./useSourceSync";

const fireflies = CONNECTORS.find((d) => d.id === "fireflies") as ConnectorDescriptor;
const gmeet = CONNECTORS.find((d) => d.id === "google-meet") as ConnectorDescriptor;
const input = { tcw: {} as TinyCloudWeb, backendUrl: "https://x.test", sessionStore: {} as SessionStore };

function deps(patch: Partial<SourceSyncDeps> = {}): SourceSyncDeps {
  return {
    secretsAvailable: () => true,
    isSecretsUnlocked: () => true,
    unlockSecrets: (async () => ({ ok: true, data: undefined })) as SourceSyncDeps["unlockSecrets"],
    getConnectorKey: (async () => ({ ok: true, data: "key" })) as SourceSyncDeps["getConnectorKey"],
    isGmeetSyncInFlight: () => false,
    runGmeetSyncNow: async () => ({ ok: true }),
    runFirefliesSyncNow: async () => ({ ok: true }),
    ...patch,
  };
}

describe("runSourceSync", () => {
  test("a clean sync resolves to no message", async () => {
    expect(await runSourceSync(fireflies, input, deps())).toBeNull();
  });

  test("an engine's own failure message is shown as is", async () => {
    const message = await runSourceSync(
      fireflies,
      input,
      deps({ runFirefliesSyncNow: async () => ({ ok: false, message: "Rate limited" }) }),
    );
    expect(message).toBe("Rate limited");
  });

  test("a rejecting engine becomes a row error instead of an unhandled rejection", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const message = await runSourceSync(
        fireflies,
        input,
        deps({
          runFirefliesSyncNow: async () => {
            throw new Error("boom");
          },
        }),
      );
      expect(message).toBe(SOURCE_SYNC_FAILED_MESSAGE);
      expect(SOURCE_SYNC_FAILED_MESSAGE).toBe("Sync failed. Try again.");
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("a rejecting vault read is also a row error", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const message = await runSourceSync(
        fireflies,
        input,
        deps({
          getConnectorKey: async () => {
            throw new Error("vault down");
          },
        }),
      );
      expect(message).toBe(SOURCE_SYNC_FAILED_MESSAGE);
    } finally {
      error.mockRestore();
    }
  });
});

describe("Full rescan and Stop reach the engine", () => {
  test("Sync now asks Google Meet for the incremental listing", async () => {
    const seen: string[] = [];
    await runSourceSync(gmeet, input, deps({ runGmeetSyncNow: async (i) => (seen.push(i.driveMode), { ok: true }) }));
    expect(seen).toEqual(["auto"]);
  });

  test("Full rescan dispatches snapshot mode to Google Meet", async () => {
    const seen: string[] = [];
    await runSourceSync(
      gmeet,
      { ...input, driveMode: "snapshot" },
      deps({ runGmeetSyncNow: async (i) => (seen.push(i.driveMode), { ok: true }) }),
    );
    expect(seen).toEqual(["snapshot"]);
  });

  test("Full rescan is refused, without reading the vault, while another Meet sync owns the slot", async () => {
    let keyReads = 0;
    let ran = 0;
    const message = await runSourceSync(
      gmeet,
      { ...input, driveMode: "snapshot" },
      deps({
        isGmeetSyncInFlight: () => true,
        getConnectorKey: (async () => (keyReads++, { ok: true, data: "key" })) as SourceSyncDeps["getConnectorKey"],
        runGmeetSyncNow: async () => (ran++, { ok: true }),
      }),
    );
    expect(message).toBe(FULL_RESCAN_BUSY_MESSAGE);
    expect([keyReads, ran]).toEqual([0, 0]);
  });

  test("Sync now that joins a run another lane owns says so, and Full rescan is Meet-only", async () => {
    let joined = 0;
    await runSourceSync(gmeet, { ...input, onJoined: () => joined++ }, deps({ isGmeetSyncInFlight: () => true }));
    expect(joined).toBe(1);
    await runSourceSync(
      fireflies,
      { ...input, driveMode: "snapshot", onJoined: () => joined++ },
      deps({
        runFirefliesSyncNow: async (engineInput) => {
          engineInput.onJoined?.();
          return { ok: true };
        },
      }),
    );
    expect(joined).toBe(2);

  });

  test("the caller's signal and progress reach the engine", async () => {
    const controller = new AbortController();
    const progress: unknown[] = [];
    let engineSignal: AbortSignal | null = null;
    await runSourceSync(
      fireflies,
      { ...input, signal: controller.signal, onProgress: (p) => progress.push(p) },
      deps({
        runFirefliesSyncNow: async (i) => {
          engineSignal = i.signal;
          i.onProgress({ phase: "storing", done: 1, total: 4 });
          return { ok: true };
        },
      }),
    );
    expect(engineSignal === controller.signal).toBe(true);
    expect(progress).toEqual([{ phase: "storing", done: 1, total: 4 }]);
  });

  test("a rate-limited engine's retry time is part of the row error", async () => {
    const message = await runSourceSync(
      fireflies,
      input,
      deps({ runFirefliesSyncNow: async () => ({ ok: false, message: "Rate limited", retryAfterMs: 30_000 }) }),
    );
    expect(message).toBe("Rate limited — try again in 30s");
  });

  test("the sync label shows counts once a total is known", () => {
    expect(syncProgressLabel(null)).toBe("Syncing…");
    expect(syncProgressLabel({ phase: "listing", done: 0, total: null })).toBe("Syncing…");
    expect(syncProgressLabel({ phase: "storing", done: 3, total: 12 })).toBe("Syncing 3/12…");
  });
});
