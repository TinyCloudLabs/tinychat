// The SDK's `account.setup.pending` (web-sdk 3.18.0): a sign-in ended for an owner with no account record, and the SDK can offer
// setup. The host takes that signal into its one finish-setup notice (shell/FinishSetupNotice.tsx). The notice's Publish is
// this app's own publish (intent.ts), the same path as the Home card and the finish-setup link; the event's `finishSetup`
// (OpenKey's own setup window) is not used. Subscribed, the SDK shows no toast of its own, so the owner sees this notice only.
import type { RegistryPublishClient } from "./adapter";
import { registryDismissedStore, type DismissedStore } from "./dismissed";
import { canOpenRegistrySetupLink } from "./setupLink";

export interface SetupPendingStore {
  /** The client whose owner the notice is asked for, or null. */
  current(): RegistryPublishClient | null;
  /**
   * Ask for the notice for `client`'s owner. Ignored where the app cannot open TinyCloud One (the card is hidden there too),
   * for an owner whose record was published from this device, and for an owner already asked in this page load, so a
   * second sign-in (a Home grant, a retry) never shows it twice.
   */
  request(client: RegistryPublishClient): void;
  /** The owner answered (Publish or Cancel): the ask is spent. */
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export function createSetupPendingStore(
  dismissed: DismissedStore = registryDismissedStore,
  canOpenSetupLink: () => boolean = canOpenRegistrySetupLink,
): SetupPendingStore {
  let pending: RegistryPublishClient | null = null;
  const askedFor = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    current: () => pending,
    request(client) {
      const owner = client.did?.toLowerCase();
      if (!owner || askedFor.has(owner) || !canOpenSetupLink() || dismissed.read(client.did!)) return;
      askedFor.add(owner);
      pending = client;
      notify();
    },
    clear() {
      if (pending === null) return;
      pending = null;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const setupPendingStore = createSetupPendingStore();
