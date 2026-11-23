// TC-3547: the SDK config that registers the consent callbacks. Empty while the switch is off, so every
// TinyCloudWeb this app builds is exactly what it was before.
import type { RegistryPublishHooks } from "@tinyboilerplate/client";
import { reportRegistryPublishError } from "./adapter";
import { requestRegistryConsent } from "./broker";
import { REGISTRY_CONSENT_MODAL_ENABLED } from "./copy";

export function registryPublishConfig(enabled: boolean = REGISTRY_CONSENT_MODAL_ENABLED): { registryPublish?: RegistryPublishHooks } {
  if (!enabled) return {};
  return { registryPublish: { onRegistryPublishConsent: requestRegistryConsent, onRegistryPublishError: reportRegistryPublishError } };
}
