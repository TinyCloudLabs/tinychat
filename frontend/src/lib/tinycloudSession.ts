import { loadPersistedSession, restoreTinyCloudWebSession } from "@tinyboilerplate/client";
import { DEFAULT_TINYCLOUD_HOST } from "./tinycloudHosts";

/** App reloads retain their session's host; configured hosts apply only to legacy hostless records. */
export function restoreSessionOnStoredHost(address: string, config: NonNullable<Parameters<typeof restoreTinyCloudWebSession>[1]>) {
  return restoreTinyCloudWebSession(address, {
    ...config,
    tinycloudHosts: loadPersistedSession(address)?.tinycloudHosts
      ?? config.tinycloudHosts ?? [DEFAULT_TINYCLOUD_HOST],
  });
}
