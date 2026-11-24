// Binding OpenKey as the signer of runtime permission grants (bot history, One Apps step-up, Canvas).

import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { openKeyFailureOf } from "./authErrors";

/**
 * What a grant signer needs from an OpenKey connection. `keyType` is OpenKey's: a `MANAGED` key signs in OpenKey's own
 * approval screen; an `EXTERNAL` key goes straight to the linked wallet's signature prompt, with no OpenKey screen.
 */
export interface OpenKeySignerConnection {
  keyType?: string;
  openkey: { signMessage(input: { message: string }): Promise<{ signature: string }> };
}

/**
 * Binds `connected`'s signer for `tcw`'s permission grants and resolves whether it was declared OpenKey. Only an
 * OpenKey-managed key is declared: OpenKey shows its own approval for each of its signatures, so the SDK skips its
 * dialog. An external-wallet key or an unknown key type is bound without the declaration, so the SDK's dialog, which
 * states the permissions and their limit, stays the ask. The pinned OpenKey client takes no presentation, so none is
 * forwarded.
 */
export function bindRuntimeSigner(tcw: TinyCloudWeb, connected: OpenKeySignerConnection): boolean {
  const declared = connected.keyType === "MANAGED";
  tcw.setRuntimePermissionSigner(
    { signMessage: async (message) => (await connected.openkey.signMessage({ message })).signature },
    declared ? { openKey: true } : undefined,
  );
  return declared;
}

/**
 * `tcw.requestPermissions`, where a cancel on OpenKey's sign screen (OpenKey rejects with `{ code: "USER_CANCELLED" }`)
 * resolves as a decline when that screen is the only ask (`declared`), as a decline in the SDK's dialog does. Any other
 * failure throws.
 */
export async function requestPermissionsDeclared(
  tcw: TinyCloudWeb,
  permissions: PermissionEntry[],
  options: Parameters<TinyCloudWeb["requestPermissions"]>[1],
  declared: boolean,
): Promise<{ approved: boolean }> {
  try {
    return await tcw.requestPermissions(permissions, options);
  } catch (error) {
    if (declared && openKeyFailureOf(error).kind === "cancelled") return { approved: false };
    throw error;
  }
}
