// One's OpenKey step-up for a framed app's request, on One's own page (pattern: bots/historyAuthorization.ts).

import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { APP_NAME } from "../lib/homeSite";
import { openkeyPasskeysSupported } from "../lib/openkeyPasskeys";

/** The slice of OpenKey's connect the step-up uses: the owner's address and a byte-exact message signer. */
export type StepUpConnect = (options: Parameters<typeof connectWallet>[0]) => Promise<{
  address: string;
  openkey: { signMessage(input: { message: string }): Promise<{ signature: string }> };
}>;

/**
 * Connects OpenKey for `session`'s owner and binds its signer to `tcw`, declared OpenKey so the SDK skips its own
 * permission dialog and OpenKey's sign screen is the only ask. Throws when the owner or session changed underneath.
 * Resolves a check that the session is still the same one.
 */
export async function bindOpenKeySigner(
  tcw: TinyCloudWeb,
  session: NonNullable<ReturnType<TinyCloudWeb["session"]>>,
  connect: StepUpConnect = connectWallet,
): Promise<() => boolean> {
  const owner = session.address.toLowerCase();
  const { chainId, sessionKey } = session;
  const sameSession = () => {
    const current = tcw.session();
    return current?.address.toLowerCase() === owner && current.chainId === chainId && current.sessionKey === sessionKey;
  };
  const connected = await connect({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
  if (connected.address.toLowerCase() !== owner || !sameSession()) throw new Error("one_apps_owner_changed");
  // OpenKey shows its own approval for each signature, so the SDK skips its prompt. The pinned OpenKey client takes no presentation, so none is forwarded.
  tcw.setRuntimePermissionSigner({ signMessage: async (message) => (await connected.openkey.signMessage({ message })).signature }, { openKey: true });
  return sameSession;
}

/**
 * Asks OpenKey for `permissions` (one `requestPermissions` call; the SDK signs once per space) and resolves true only
 * when this same session now holds all of them. Throws when the owner or session changed underneath.
 */
export async function stepUpForApp(tcw: TinyCloudWeb, permissions: PermissionEntry[], connect: StepUpConnect = connectWallet): Promise<boolean> {
  const session = tcw.session();
  if (!session) return false;
  const sameSession = await bindOpenKeySigner(tcw, session, connect);
  const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
  const expiryMs = expires - Date.now();
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) return false;
  const result = await tcw.requestPermissions(permissions, { expiryMs });
  return result.approved && sameSession() && tcw.hasPermissions(permissions);
}
