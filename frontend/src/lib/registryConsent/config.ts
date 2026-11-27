// TC-3547: the SDK config that sends the SDK's registry-publish errors to the session log.
import type { RegistryPublishHooks } from "@tinyboilerplate/client";
import { reportRegistryPublishError, type RegistryPublishClient } from "./adapter";
import { setupPendingStore } from "./setupPending";

/**
 * The SDK hooks for the registry record: errors go to the session log, and `account.setup.pending` goes to the one
 * finish-setup notice (setupPending.ts), so the SDK's own setup toast never shows.
 */
export function registryPublishConfig(): { registryPublish: RegistryPublishHooks; onAccountSetupPending: (client: RegistryPublishClient) => void } {
  return {
    registryPublish: { onRegistryPublishError: reportRegistryPublishError },
    onAccountSetupPending: (client) => setupPendingStore.request(client),
  };
}
