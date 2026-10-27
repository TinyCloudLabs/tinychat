import { loadAppManifest } from "@tinyboilerplate/client";
import type { Manifest } from "@tinycloud/sdk-core";

/**
 * The web client's manifest, with the app's key declaration (`keys_app_id`, `keys`). OpenKey checks
 * `apps/<id>/` key grants against the file it fetches from the origin at this path, so the client
 * reads that same file: the digest it sends is the digest of what OpenKey fetches. The backend's
 * `/api/manifest` never carries the declaration.
 */
export const OPENKEY_MANIFEST_PATH = "/.well-known/openkey-manifest.json";

export function loadWebManifest(): Promise<Manifest> {
  return loadAppManifest(OPENKEY_MANIFEST_PATH);
}
