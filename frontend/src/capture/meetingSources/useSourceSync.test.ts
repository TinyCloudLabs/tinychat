import { describe, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { FirefliesClient } from "@/lib/connectors/firefliesClient";
import * as connectorStore from "@/lib/connectors/connectorStore";
import { syncFireflies } from "@/lib/connectors/firefliesSync";
import { clearBackgroundDrainRecord } from "@/chat/useBackgroundDrain";
import { makeFakeTinyCloud } from "../../../../test/connectors/fake-tinycloud";
import { buildSeed, startMockFireflies } from "../../../../test/connectors/mock-fireflies.mjs";
import type { ConnectorDescriptor } from "@/lib/connectors/types";
import { CONNECTORS } from "@/lib/connectors/registry";
import {
  SOURCE_SYNC_FAILED_MESSAGE,
  runSourceSync,
  syncProgressLabel,
  useSourceSync,
  type SourceSyncController,
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
    readConnectorKey: (async () => ({ ok: true, data: "key" })) as SourceSyncDeps["readConnectorKey"],
    isGmeetSyncInFlight: () => false,
    isGmeetNotesSyncInFlight: () => false,
    awaitSessionSync: async () => {},
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
          readConnectorKey: async () => {
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

  test("Full rescan is offered a wait, without reading the vault, while another Meet sync owns the slot", async () => {
    let keyReads = 0;
    let ran = 0;
    const message = await runSourceSync(
      gmeet,
      { ...input, driveMode: "snapshot" },
      deps({
        isGmeetSyncInFlight: () => true,
        readConnectorKey: (async () => (keyReads++, { ok: true, data: "key" })) as SourceSyncDeps["readConnectorKey"],
        runGmeetSyncNow: async () => (ran++, { ok: true }),
      }),
    );
    expect(message).toEqual({ busy: "offer" });
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
describe("mounted Meeting sources account generation", () => {
  test("sign-out while a manual request joins queued catch-up prevents its follow-up", async () => {
    connectorStore._resetConnectorSchemaMemoForTests();
    const seed = buildSeed(51);
    const handle = await startMockFireflies({ mode: "happy", seed });
    const fake = makeFakeTinyCloud({ did: "did:test:source-sync-signout" });
    const listStarted = Promise.withResolvers<void>();
    const releaseList = Promise.withResolvers<void>();
    const manualJoined = Promise.withResolvers<void>();
    let listCalls = 0;
    const api = new FirefliesClient({
      apiKey: "test-source-sync-key",
      apiUrl: handle.url,
      delayMs: 0,
      fetchImpl: async (url, init) => {
        const payload = JSON.parse(String(init?.body)) as { query?: string };
        if (payload.query?.includes("query ListTranscripts")) {
          listCalls++;
          if (listCalls === 1) {
            listStarted.resolve();
            await releaseList.promise;
          }
        }
        return fetch(url, init);
      },
    });
    const deps = depsForSourceSync(fake.tcw, api, manualJoined);
    const window = new Window();
    const globals = ["window", "document", "navigator", "HTMLElement", "MutationObserver"] as const;
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const name of globals) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: name === "window" ? window
          : name === "document" ? window.document
            : name === "navigator" ? window.navigator
              : name === "HTMLElement" ? window.HTMLElement
                : window.MutationObserver,
      });
    }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const root = createRoot(container);
    let controller: SourceSyncController | null = null;
    function Harness() {
      controller = useSourceSync({
        tcw: fake.tcw,
        backendUrl: "https://example.test",
        sessionStore: {} as SessionStore,
        onSettled: () => {},
        deps,
      });
      return null;
    }

    try {
      expect((await connectorStore.updateSyncState(fake.tcw, {
        connectorId: "fireflies",
        status: "connected",
        lastSyncedAt: null,
        lastSyncStatus: "ok",
        lastSyncError: null,
        itemCount: 0,
      })).ok).toBe(true);
      await act(async () => { root.render(createElement(Harness)); });
      const background = syncFireflies({
        client: api,
        store: connectorStore,
        tcw: fake.tcw,
        detailCap: 50,
      });
      await listStarted.promise;
      let manual!: Promise<void>;
      await act(async () => { manual = controller!.sync(fireflies); });
      await manualJoined.promise;
      expect(controller?.joined).toBe(true);

      clearBackgroundDrainRecord();
      releaseList.resolve();
      await act(async () => { await Promise.all([background, manual]); });

      expect(listCalls).toBe(1);
      expect(fake.sql.meetings.size).toBe(0);
      expect(fake.sql.states.get("fireflies")?.last_sync_status).toBe("ok");
    } finally {
      releaseList.resolve();
      await act(async () => { root.unmount(); });
      await handle.stop();
      for (const name of globals) {
        const property = previous.get(name);
        if (property) Object.defineProperty(globalThis, name, property);
        else Reflect.deleteProperty(globalThis, name);
      }
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      await window.happyDOM.abort();
    }
  });
});

function depsForSourceSync(
  tcw: TinyCloudWeb,
  client: FirefliesClient,
  manualJoined: { resolve: () => void },
): SourceSyncDeps {
  return {
    secretsAvailable: () => true,
    isSecretsUnlocked: () => true,
    unlockSecrets: (async () => ({ ok: true, data: undefined })) as SourceSyncDeps["unlockSecrets"],
    readConnectorKey: (async () => ({ ok: true, data: "test-source-sync-key" })) as SourceSyncDeps["readConnectorKey"],
    isGmeetSyncInFlight: () => false,
    isGmeetNotesSyncInFlight: () => false,
    awaitSessionSync: async () => {},
    runGmeetSyncNow: async () => ({ ok: true }),
    runFirefliesSyncNow: async (input) => {
      const result = await syncFireflies({
        client,
        store: connectorStore,
        tcw,
        signal: input.signal,
        isCurrent: input.isCurrent,
        manualRequest: true,
        onJoined: () => {
          manualJoined.resolve();
          input.onJoined?.();
        },
        onJoinSettled: input.onJoinSettled,
      });
      return result.ok
        ? { ok: true }
        : { ok: false, message: result.error.message, retryAfterMs: result.error.retryAfterMs };
    },
  };
}
