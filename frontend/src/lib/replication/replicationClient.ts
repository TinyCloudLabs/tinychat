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
import { noteReplicationCopyPossible } from "./replicationCopyMarker";
import { isReplicationEnabled } from "./replicationFlag";
import { startupPurgeSettled } from "./replicationStartupPurge";
import { replicationPrefixes } from "./replicationPrefixes";
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
