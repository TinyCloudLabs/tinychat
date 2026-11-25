// TC-3547: the SDK config that sends the SDK's registry-publish errors to the session log.
import type { RegistryPublishHooks } from "@tinyboilerplate/client";
import { reportRegistryPublishError } from "./adapter";

export function registryPublishConfig(): { registryPublish: RegistryPublishHooks } {
  return { registryPublish: { onRegistryPublishError: reportRegistryPublishError } };
}
