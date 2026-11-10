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
import { isReplicaError, ReplicaErrorCode } from "@tinycloud/replica";
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

/** Background sync interval: 5 minutes. */
export const REPLICATION_SYNC_INTERVAL_MS = 300_000;

/** A local read older than this syncs first: 15 minutes. */
export const REPLICATION_MAX_STALENESS_MS = 900_000;

/**
 * The local copy syncs entry NAMES only; a value is not downloaded until something reads it
 * (a read of a name-only key falls through to the network). The app reads every replicated
 * prefix from the network today, so nothing fetches values in bulk. `replication.sync`'s
 * `contentMissing` count is non-zero on a healthy lazy copy: it is not a fault.
 */
export const REPLICATION_CONTENT_FETCH = "lazy" as const;

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
    syncIntervalMs: REPLICATION_SYNC_INTERVAL_MS,
    maxStalenessMs: REPLICATION_MAX_STALENESS_MS,
    contentFetch: REPLICATION_CONTENT_FETCH,
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
  /** Test seam: avoid wall-clock spacing in focused queue tests. */
  startGapMs?: number;
}

function sleep(ms: number): Promise<void> {
  // Executor form on purpose: this tsconfig's lib has no Promise.withResolvers.
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

const terminalGrantRefusals = new WeakSet<TinyCloudWeb>();

function isNonCompactGrantRefusal(error: unknown): boolean {
  return isReplicaError(error, ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED);
}

/**
 * Starts the first sync of a freshly signed-in/restored replica client. Nothing in the SDK does:
 * a prefix is opened (first-synced, put on the interval timer) only by a read-through read or by
 * `replication.sync()`, and the app's transcript reads are `source: "network"`.
 * Only when this client HAS a replication controller and the user's opt-in is ON (re-checked before
 * EVERY prefix start), and never while a removal of the copy is in flight. The fill waits for the
 * app's first data load to settle (success or error; at most REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS),
 * then probes one prefix before starting the remaining bounded, spaced worker fill. This prevents a
 * session-wide non-compact grant refusal from fanning out across concurrent prefix starts.
 * Switch-off / sign-out (controller gone) stops every prefix not yet started; one already started is
 * left to the SDK's own teardown. A non-compact-UCAN refusal is terminal for this client session:
 * close the controller and log once. Other sync errors do not stop later prefixes.
 */
export function startReplicationFill(
  tcw: TinyCloudWeb,
  isEnabled: () => boolean = () => isReplicationEnabled({ principal: tcw.did }),
  deps: ReplicationFillDeps = {},
): void {
  if (terminalGrantRefusals.has(tcw)) return;
  const canStart = (): boolean => !terminalGrantRefusals.has(tcw) && clientHasReplication(tcw) && isEnabled();
  if (!canStart()) return;
  if (!deps.firstLoadSettled) resetAppFirstLoad(); // a new sign-in/restore waits for ITS first load
  const firstLoadSettled = deps.firstLoadSettled ?? appFirstLoadSettled;
  const queue = [...(deps.prefixes ?? replicationPrefixes())];
  const startGapMs = deps.startGapMs ?? REPLICATION_FILL_START_GAP_MS;
  void (async () => {
    await startupPurgeSettled();
    let cancelDeadline = (): void => {};
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS);
      cancelDeadline = () => clearTimeout(timer);
    });
    await Promise.race([firstLoadSettled().catch(() => undefined), deadline]);
    cancelDeadline();

    const stopForGrantRefusal = (error: unknown): void => {
      if (!isNonCompactGrantRefusal(error) || terminalGrantRefusals.has(tcw)) return;
      terminalGrantRefusals.add(tcw);
      queue.length = 0;
      console.debug("[replication] stopped for session: compact UCAN required");
      try {
        void Promise.resolve(tcw.replication?.close()).catch(() => undefined);
      } catch {
        // The grant refusal is terminal even if teardown itself fails.
      }
    };

    const syncPrefix = (prefix: string): Promise<unknown> => {
      if (!canStart()) return Promise.resolve();
      try {
        return Promise.resolve(tcw.replication?.sync({ prefix })).catch(stopForGrantRefusal);
      } catch (error) {
        stopForGrantRefusal(error);
        return Promise.resolve();
      }
    };

    // The grant refusal applies to the entire session. Probe one prefix before starting
    // workers so a rejected grant cannot fan out into several concurrent retries.
    const firstPrefix = queue.shift();
    if (firstPrefix) {
      await syncPrefix(firstPrefix);
      if (terminalGrantRefusals.has(tcw)) return;
      if (startGapMs > 0) await sleep(startGapMs);
    }

    // Once the first sync succeeds, other errors retain the existing bounded fill behavior.
    let turn: Promise<void> = Promise.resolve();
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const prefix = queue.shift()!;
        let sync: Promise<unknown> | undefined;
        const slot = turn.then(() => {
          if (!canStart()) { queue.length = 0; return undefined; }
          sync = syncPrefix(prefix);
          return startGapMs > 0 ? sleep(startGapMs) : Promise.resolve();
        });
        turn = slot;
        await slot;
        await sync;
      }
    };
    await Promise.all(Array.from({ length: REPLICATION_FILL_POOL_SIZE }, worker));
  })().catch(() => undefined);
}
