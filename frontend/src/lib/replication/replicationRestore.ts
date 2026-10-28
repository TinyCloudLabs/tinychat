// What a session restore adds to its client config for local replication: the replication option
// (replicationClient.ts) and, only when that option was built, the read-only account provider the
// SDK's restore needs (readOnlyAccountProvider.ts). With replication OFF for this account the patch is
// `{}`: the restore config is exactly what it is without replication, with no provider and no signer.
import { replicationConfigPatch, type ReplicationClientConfig, type ReplicationPluginLoader } from "./replicationClient";
import { replicationPrincipalFor } from "./replicationOptIn";
import { readOnlyAccountProvider } from "./readOnlyAccountProvider";
import type { EIP1193Provider } from "@tinyboilerplate/client";

export async function replicationRestorePatch(
  storedAddress: string,
  loader?: ReplicationPluginLoader,
): Promise<{ replication?: ReplicationClientConfig; provider?: EIP1193Provider }> {
  const patch = await replicationConfigPatch(replicationPrincipalFor(storedAddress), loader);
  return patch.replication ? { ...patch, provider: readOnlyAccountProvider(storedAddress) } : patch;
}
