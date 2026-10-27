import { loadAppManifest } from "@tinyboilerplate/client";
import type { Manifest } from "@tinycloud/sdk-core";

/**
 * The backend serves the manifest's named-key rows (`keys_app_id`, `keys`) only
 * to a request that carries `keys=1`. The web client signs in through OpenKey's
 * authorize review, which admits app keys, so every web manifest load sends it.
 */
export function manifestUrlWithKeys(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}keys=1`;
}

export function loadWebManifest(url: string): Promise<Manifest> {
  return loadAppManifest(manifestUrlWithKeys(url));
}
