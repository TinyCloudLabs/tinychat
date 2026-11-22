// TC-3547: should Home's "finish setup" card show? Only for an account the registry does not know yet, and not after the
// owner answered "Not now" (kept on this device per owner: dismissed.ts), so it holds across sign-ins. Read once when the
// page loads a signed-in client. Off while the consent is off, and when the SDK cannot publish (the card's
// action would lead nowhere).
import {
  canPublishRegistryRecord,
  readRegistryUnregistered,
  type RegistryPublishClient,
} from "./adapter";
import { REGISTRY_CONSENT_MODAL_ENABLED } from "./copy";
import { registryDismissedStore, type DismissedStore } from "./dismissed";

export async function finishSetupBannerVisible(
  tcw: RegistryPublishClient | null | undefined,
  enabled: boolean = REGISTRY_CONSENT_MODAL_ENABLED,
  unregistered: (tcw: RegistryPublishClient) => Promise<boolean> = readRegistryUnregistered,
  dismissed: DismissedStore = registryDismissedStore,
): Promise<boolean> {
  if (!enabled || !canPublishRegistryRecord(tcw)) return false;
  if (tcw.did && dismissed.read(tcw.did)) return false;
  return unregistered(tcw);
}
