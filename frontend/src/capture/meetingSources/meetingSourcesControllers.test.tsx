// The Meeting sources controllers, mounted together the way the window wires them
// (Sync now / Stop / Disconnect). No DOM here: a probe that renders nothing is
// mounted on a stub container, as capture/meeting/useMeetingBot.test.tsx does.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  initialDisconnectProgress,
  type DisconnectDeps,
  type DisconnectMode,
  type DisconnectProgress,
  type runDisconnect,
} from "@/lib/connectors/connectorLifecycle";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorDescriptor } from "@/lib/connectors/types";
import { useConnectorDisconnect, type ConnectorDisconnectController } from "./useConnectorDisconnect";
import { useSourceSync, type SourceSyncController, type SourceSyncDeps } from "./useSourceSync";

const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  ownerDocument: null,
  textContent: "",
  addEventListener() {},
  removeEventListener() {},
} as unknown as HTMLElement;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

const fireflies = CONNECTORS.find((d) => d.id === "fireflies") as ConnectorDescriptor;
const tcw = {} as TinyCloudWeb;
const sessionStore = {} as SessionStore;

/** What the window does: the disconnect is blocked while this window's sync is running. */
function Probe(props: {
  deps: SourceSyncDeps;
  runner: typeof runDisconnect;
  out: { sync?: SourceSyncController; disconnect?: ConnectorDisconnectController };
}) {
  const sync = useSourceSync({ tcw, backendUrl: "https://x.test", sessionStore, onSettled: () => {}, deps: props.deps });
  const disconnect = useConnectorDisconnect({
    tcw,
    descriptor: fireflies,
    webhooks: {} as never,
    backendUrl: "https://x.test",
    sessionStore,
    featureDark: false,
    blocked: sync.syncingId === fireflies.id,
    onDisconnected: () => {},
    runner: props.runner,
  });
  props.out.sync = sync;
  props.out.disconnect = disconnect;
  return null;
}

async function mount(props: Parameters<typeof Probe>[0]) {
  root = createRoot(container);
  await act(async () => root!.render(<Probe {...props} />));
}

const syncDeps = (engine: SourceSyncDeps["runFirefliesSyncNow"]): SourceSyncDeps => ({
  secretsAvailable: () => true,
  isSecretsUnlocked: () => true,
  unlockSecrets: (async () => ({ ok: true, data: undefined })) as SourceSyncDeps["unlockSecrets"],
  getConnectorKey: (async () => ({ ok: true, data: "key" })) as SourceSyncDeps["getConnectorKey"],
  isGmeetSyncInFlight: () => false,
  isGmeetNotesSyncInFlight: () => false,
  awaitSessionSync: async () => {},
  runGmeetSyncNow: async () => ({ ok: true }),
  runFirefliesSyncNow: engine,
});

/** A teardown that finishes whatever plan it is handed, recording the order of writes. */
function recordingRunner(store: { writes: string[]; modes: DisconnectMode[] }): typeof runDisconnect {
  return async (deps: DisconnectDeps, update, from) => {
    store.modes.push(deps.mode);
    store.writes.push("disconnect: connected=false");
    const done: DisconnectProgress = { ...(from ?? initialDisconnectProgress(deps.mode)), done: true };
    update(() => done);
    return done;
  };
}

describe("disconnect while this window's sync is running", () => {
  test("is refused until the sync has settled, so the engine's final write cannot resurrect the connection", async () => {
    const store = { writes: [] as string[], modes: [] as DisconnectMode[] };
    let release: () => void = () => {};
    let engineSignal: AbortSignal | null = null;
    const engine: SourceSyncDeps["runFirefliesSyncNow"] = (input) =>
      new Promise((resolve) => {
        engineSignal = input.signal;
        // Like the real engines, the last thing a run does is write "connected".
        release = () => {
          store.writes.push("sync: final write connected=true");
          resolve({ ok: true });
        };
      });
    const out: Parameters<typeof Probe>[0]["out"] = {};
    await mount({ deps: syncDeps(engine), runner: recordingRunner(store), out });

    let syncDone: Promise<void> = Promise.resolve();
    await act(async () => {
      syncDone = out.sync!.sync(fireflies);
    });
    expect(out.sync!.syncingId).toBe("fireflies");

    // An already-open Manage panel's Disconnect: nothing is torn down.
    await act(async () => out.disconnect!.run("keep-data"));
    await act(async () => out.disconnect!.run("delete-data"));
    expect(store.modes).toEqual([]);

    // Stop aborts the engine's signal, but the row stays busy until the engine settles.
    await act(async () => out.sync!.stop());
    expect(engineSignal !== null && (engineSignal as AbortSignal).aborted).toBe(true);
    expect(out.sync!.syncingId).toBe("fireflies");
    await act(async () => out.disconnect!.run("keep-data"));
    expect(store.modes).toEqual([]);

    await act(async () => {
      release();
      await syncDone;
    });
    expect(out.sync!.syncingId).toBeNull();

    await act(async () => out.disconnect!.run("keep-data"));
    expect(store.modes).toEqual(["keep-data"]);
    expect(store.writes).toEqual(["sync: final write connected=true", "disconnect: connected=false"]);
  });

  test("a second Sync now while one is running does not start another engine run", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const engine: SourceSyncDeps["runFirefliesSyncNow"] = () =>
      new Promise((resolve) => {
        runs += 1;
        release = () => resolve({ ok: true });
      });
    const out: Parameters<typeof Probe>[0]["out"] = {};
    await mount({ deps: syncDeps(engine), runner: recordingRunner({ writes: [], modes: [] }), out });
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = out.sync!.sync(fireflies);
    });
    await act(async () => out.sync!.sync(fireflies));
    expect(runs).toBe(1);
    await act(async () => {
      release();
      await first;
    });
  });
});

describe("disconnect plans", () => {
  test("keep-data and delete-data each reach the lifecycle runner as chosen", async () => {
    for (const mode of ["keep-data", "delete-data"] as const) {
      const store = { writes: [] as string[], modes: [] as DisconnectMode[] };
      const out: Parameters<typeof Probe>[0]["out"] = {};
      await mount({ deps: syncDeps(async () => ({ ok: true })), runner: recordingRunner(store), out });
      await act(async () => out.disconnect!.run(mode));
      expect(store.modes).toEqual([mode]);
      expect(out.disconnect!.done).toBe(true);
      await act(async () => root!.unmount());
      root = null;
    }
  });

  test("a delete-data teardown that stopped part-way keeps its plan on retry, and locks the choice", async () => {
    const modes: DisconnectMode[] = [];
    let attempt = 0;
    const runner: typeof runDisconnect = async (deps, update, from) => {
      modes.push(deps.mode);
      attempt += 1;
      const progress: DisconnectProgress =
        attempt === 1
          ? {
              ...initialDisconnectProgress(deps.mode),
              failure: { step: "tombstone", message: "Could not reach the server", retryable: true },
            }
          : { ...(from ?? initialDisconnectProgress(deps.mode)), failure: null, done: true };
      update(() => progress);
      return progress;
    };
    const out: Parameters<typeof Probe>[0]["out"] = {};
    await mount({ deps: syncDeps(async () => ({ ok: true })), runner, out });
    expect(out.disconnect!.planLocked).toBe(false);
    await act(async () => out.disconnect!.run("delete-data"));
    expect(out.disconnect!.done).toBe(false);
    expect(out.disconnect!.planLocked).toBe(true);
    expect(out.disconnect!.retryLabel).not.toBeNull();
    // Even if the choice were flipped, the resumed run stays on the pinned plan.
    await act(async () => out.disconnect!.run("keep-data"));
    expect(modes).toEqual(["delete-data", "delete-data"]);
    expect(out.disconnect!.done).toBe(true);
  });
});
