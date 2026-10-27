import { TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";

const REVISION = "1";
const STORAGE_PREFIX = "xyz.tinycloud.tinychat:named-key-revision:";

interface RevisionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function key(address: string): string {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

export function manifestCarriesConnectorKey(manifest: unknown): boolean {
  if (manifest === null || typeof manifest !== "object") return false;
  const value = manifest as { keys_app_id?: unknown; keys?: unknown };
  return value.keys_app_id === "chat.tinycloud.tinychat" && Array.isArray(value.keys) &&
    value.keys.some((entry) => entry?.prefix === TINYCHAT_KEY_PREFIX &&
      Array.isArray(entry.abilities) && entry.abilities.length === 2 &&
      entry.abilities.includes("key.create") && entry.abilities.includes("decrypt"));
}

export function recordConnectorKeyRevision(store: RevisionStore | null, address: string, manifest: unknown): void {
  if (!store || !manifestCarriesConnectorKey(manifest)) return;
  try { store.setItem(key(address), REVISION); } catch { /* Next restore asks again. */ }
}

/** Clear a stored session once the served manifest can grant the connector key. */
export async function applyConnectorKeyRevisionGate(input: {
  store: RevisionStore | null;
  address: string | null;
  isOffline: () => boolean;
  loadManifest: () => Promise<unknown>;
  handoff: () => Promise<boolean>;
  clearSession: (address: string) => void;
}): Promise<"current" | "deferred" | "cleared" | "handoff_failed"> {
  const { store, address } = input;
  if (!address) return "current";
  try { if (store?.getItem(key(address)) === REVISION) return "current"; } catch { /* Treat unreadable as stale. */ }
  if (input.isOffline()) return "deferred";
  const manifest = await input.loadManifest().catch(() => null);
  if (!manifestCarriesConnectorKey(manifest)) return "deferred";
  if (!await input.handoff()) return "handoff_failed";
  input.clearSession(address);
  return "cleared";
}
