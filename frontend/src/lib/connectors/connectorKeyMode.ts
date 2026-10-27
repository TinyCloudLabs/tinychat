import { TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";
import { isAppKeyHostBound, type Manifest } from "@tinycloud/web-sdk";
import { withEncryptionDecryptGrant } from "./encryptionGrant";

const TINYCHAT_KEYS_APP_ID = TINYCHAT_KEY_PREFIX.slice("apps/".length, -1);

export function usesNamedConnectorKeys(): boolean {
  return isAppKeyHostBound(TINYCHAT_KEYS_APP_ID, typeof window === "undefined" ? "" : window.location?.origin ?? "");
}

export function connectorSignInManifest(manifest: Manifest, address: string): Manifest {
  return usesNamedConnectorKeys() ? manifest : withEncryptionDecryptGrant(manifest, address);
}
