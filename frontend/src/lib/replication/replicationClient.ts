// Builds the `replication` client option, only when replication is ON for the signed-in user
// (build flag + platform + the user's own switch; replicationFlag.ts).
//
// OFF (any gate): returns undefined and imports NOTHING. The optional plugin
// (`@tinycloud/web-sdk/replica`, which in turn lazily loads the encrypted IndexedDB storage
// `@tinycloud/replica/kv-storage` and its worker) is behind dynamic imports, so it stays out of the
// root bundle, and the client config is byte-for-byte what it was without replication.
//
// Grant (SECURITY, see replicationSignOut.ts for the sign-out half): the manifest is NOT changed.
// With `replication.enabled`, the SDK itself adds `tinycloud.kv/sync` next to the existing
// `tinycloud.kv/get` for exactly these prefixes at sign-in, and only where an unrestricted `get`
// already covers them (augmentSignInEntriesWithReplication in node-sdk). Flag OFF: no sync entry,
// so existing sessions get exactly what they got before.
import type { TinyCloudWebConfig } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { noteReplicationCopyPossible } from "./replicationCopyMarker";
import { isReplicationEnabled } from "./replicationFlag";
import { appFirstLoadSettled, resetAppFirstLoad } from "./replicationFirstLoad";
import { startupPurgeSettled } from "./replicationStartupPurge";
import { replicationPrefixes } from "./replicationPrefixes";
import { clientHasReplication } from "./replicationSignOut";
import { recordReplicationEvent } from "./replicationStatus";

/**
 * Origin-wide replica byte budget. Over budget, sync STOPS with STORAGE_BUDGET and nothing is
 * evicted: a heavy user silently stops mirroring NEW meetings. Sealed rows add AES-GCM and
 * metadata overhead on top of raw JSON (measured ratio: see replicationClient.test.ts), so this
 * leaves headroom. Surfaced by the debug status line.
 */
export const REPLICATION_MAX_BYTES = 100 * 1024 * 1024;

export type ReplicationClientConfig = NonNullable<TinyCloudWebConfig["replication"]>;

/** Test seam: how the plugin and storage factory are obtained. Production uses dynamic imports. */
export interface ReplicationPluginLoader {
  registerPlugin(): Promise<void>;
  createStorage(): Promise<ReplicationClientConfig["storage"]>;
}

let pluginRegistered = false;

/** Production loader; also used by replicationOffPurge.ts (lazily, only when a copy may exist). */
export const defaultReplicationLoader: ReplicationPluginLoader = {
  async registerPlugin() {
    if (pluginRegistered) return; // registerBrowserReplica throws on duplicate registration
    // Dynamic on purpose: the optional plugin (and the web-sdk root, which is already in the main
    // graph) must not be evaluated unless the flag is ON.
    const [{ registerBrowserReplica }, { browserReplicaPlugin }] = await Promise.all([
      import("@tinycloud/web-sdk"),
      import("@tinycloud/web-sdk/replica"),
    ]);
    registerBrowserReplica(browserReplicaPlugin);
    pluginRegistered = true;
  },
  async createStorage() {
    const { loadIndexedDbReplicaStorage } = await import("@tinycloud/web-sdk/replica");
    // The encrypted adapter (AES-GCM, non-extractable keys). There is no plaintext fallback.
    return (await loadIndexedDbReplicaStorage())();
  },
};

/** The SDK sync scope of the production replication config: ONE source of truth (tests import it). */
export const REPLICATION_SYNC_SCOPE = "prefixes" as const;

/** The `replication` option for sign-in/restore of `principal`, or undefined when replication is OFF for them. */
export async function buildReplicationConfig(
  principal: string | undefined,
  loader: ReplicationPluginLoader = defaultReplicationLoader,
): Promise<ReplicationClientConfig | undefined> {
  if (!isReplicationEnabled({ principal })) return undefined;
  // A page-load purge may still be deleting the origin copy (a pending wipe): never build over it.
  await startupPurgeSettled();
  // Before any copy can exist: lets a later OFF load find it (replicationOffPurge.ts).
  noteReplicationCopyPossible();
  await loader.registerPlugin();
  return {
    enabled: true,
    prefixes: replicationPrefixes(),
    syncScope: REPLICATION_SYNC_SCOPE,
    maxBytes: REPLICATION_MAX_BYTES,
    storage: await loader.createStorage(),
    onEvent: recordReplicationEvent,
  };
}

/** Spread into a client config: `{}` when OFF so the config object is unchanged. */
export async function replicationConfigPatch(
  principal: string | undefined,
  loader?: ReplicationPluginLoader,
): Promise<{ replication?: ReplicationClientConfig }> {
  const replication = await buildReplicationConfig(principal, loader);
  return replication ? { replication } : {};
}

/** Prefixes brought up at the same time. ONE place; the node allows 3 at most. */
export const REPLICATION_FILL_POOL_SIZE = 2;
/** Minimum spacing between two prefix starts (each kv/sync holds a node DB connection while it loads). */
export const REPLICATION_FILL_START_GAP_MS = 200;
/**
 * The fill starts anyway this long after sign-in if the app's first load never settles. Longer than
 * the thread-list read's own retry budget (about 40 s), so the fill never starts its prefixes while
 * that read is still retrying on a stalled node.
 */
export const REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS = 45_000;

/** Test seam. Production uses the app's first-load signal and the real prefix list. */
export interface ReplicationFillDeps {
  firstLoadSettled?: () => Promise<void>;
  prefixes?: readonly string[];
}

function sleep(ms: number): Promise<void> {
  // Executor form on purpose: this tsconfig's lib has no Promise.withResolvers.
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Starts the first sync of a freshly signed-in/restored replica client. Nothing in the SDK does:
 * a prefix is opened (first-synced, put on the interval timer) only by a read-through read or by
 * `replication.sync()`, and the app's transcript reads are `source: "network"`.
 * Only when this client HAS a replication controller and the user's opt-in is ON (re-checked before
 * EVERY prefix start), and never while a removal of the copy is in flight. The fill waits for the
 * app's first data load to settle (success or error; at most REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS),
 * then syncs the prefixes one by one with at most REPLICATION_FILL_POOL_SIZE in flight and starts
 * spaced REPLICATION_FILL_START_GAP_MS apart, so a burst of kv/sync does not queue the app's reads.
 * Switch-off / sign-out (controller gone) stops every prefix not yet started; one already started is
 * left to the SDK's own teardown. A failing sync (for example a gated restore) is reported through the
 * SDK's events and the status line, never thrown into sign-in, and does not stop the other prefixes.
 */
export function startReplicationFill(
  tcw: TinyCloudWeb,
  isEnabled: () => boolean = () => isReplicationEnabled({ principal: tcw.did }),
  deps: ReplicationFillDeps = {},
): void {
  const canStart = (): boolean => clientHasReplication(tcw) && isEnabled();
  if (!canStart()) return;
  if (!deps.firstLoadSettled) resetAppFirstLoad(); // a new sign-in/restore waits for ITS first load
  const firstLoadSettled = deps.firstLoadSettled ?? appFirstLoadSettled;
  const queue = [...(deps.prefixes ?? replicationPrefixes())];
  void (async () => {
    await startupPurgeSettled();
    let cancelDeadline = (): void => {};
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS);
      cancelDeadline = () => clearTimeout(timer);
    });
    await Promise.race([firstLoadSettled().catch(() => undefined), deadline]);
    cancelDeadline();
    // Starts are taken one at a time, each followed by the gap, so they are ordered and spaced.
    let turn: Promise<void> = Promise.resolve();
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const prefix = queue.shift()!;
        let sync: Promise<unknown> | undefined;
        const slot = turn.then(() => {
          if (!canStart()) { queue.length = 0; return undefined; }
          // Caught at once (the gap below must not leave a rejection unhandled); the SDK reports it.
          try { sync = Promise.resolve(tcw.replication?.sync({ prefix })).catch(() => undefined); } catch { /* reported by the SDK events */ }
          return sleep(REPLICATION_FILL_START_GAP_MS);
        });
        turn = slot;
        await slot;
        await sync;
      }
    };
    await Promise.all(Array.from({ length: REPLICATION_FILL_POOL_SIZE }, worker));
  })().catch(() => undefined);
}
