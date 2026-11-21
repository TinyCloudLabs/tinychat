// TC-3547: should Home's "finish setup" banner show? Not after the owner answered "Not now": the SDK stores that in the
// account-registry KV, so it holds across sign-ins and devices. Read once when the page loads a signed-in client.
import { canPublishRegistryRecord, readRegistryPublishDismissed, type RegistryPublishClient } from "./adapter";
import { REGISTRY_CONSENT_MODAL_ENABLED } from "./copy";

export async function finishSetupBannerVisible(
  tcw: RegistryPublishClient | null | undefined,
  enabled: boolean = REGISTRY_CONSENT_MODAL_ENABLED,
): Promise<boolean> {
  if (!enabled || !canPublishRegistryRecord(tcw)) return false;
  return !(await readRegistryPublishDismissed(tcw));
}
