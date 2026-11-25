// TC-3547: should Home's "finish setup" card show? Only for an account the registry does not know yet, that has not tapped
// the card's button on this device (dismissed.ts), in an app that can open TinyCloud One when the SDK sends the owner
// there. Read once when the page loads a signed-in client.
import { readRegistryUnregistered, type RegistryPublishClient } from "./adapter";
import { registryDismissedStore, type DismissedStore } from "./dismissed";
import { canOpenRegistrySetupLink } from "./setupLink";

export async function finishSetupBannerVisible(
  tcw: RegistryPublishClient | null | undefined,
  unregistered: (tcw: RegistryPublishClient) => Promise<boolean> = readRegistryUnregistered,
  canOpenSetupLink: () => boolean = canOpenRegistrySetupLink,
  dismissed: DismissedStore = registryDismissedStore,
): Promise<boolean> {
  if (!tcw || !canOpenSetupLink()) return false;
  if (tcw.did && dismissed.read(tcw.did)) return false;
  return unregistered(tcw);
}
