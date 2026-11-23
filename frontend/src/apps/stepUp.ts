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
 * Asks OpenKey for `permissions` (one `requestPermissions` call; the SDK signs once per space) and resolves true only
 * when this same session now holds all of them. Throws when the owner or session changed underneath. The grant lasts as
 * long as the session, or `maxExpiryMs` when that is shorter.
 */
export async function stepUpForApp(tcw: TinyCloudWeb, permissions: PermissionEntry[], connect: StepUpConnect = connectWallet, maxExpiryMs = Number.POSITIVE_INFINITY): Promise<boolean> {
  const session = tcw.session();
  if (!session) return false;
  const owner = session.address.toLowerCase();
  const { chainId, sessionKey } = session;
  const sameSession = () => {
    const current = tcw.session();
    return current?.address.toLowerCase() === owner && current.chainId === chainId && current.sessionKey === sessionKey;
  };
  const connected = await connect({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
  if (connected.address.toLowerCase() !== owner || !sameSession()) throw new Error("one_apps_owner_changed");
  tcw.setRuntimePermissionSigner({ signMessage: async (message) => (await connected.openkey.signMessage({ message })).signature });
  const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
  const expiryMs = Math.min(expires - Date.now(), maxExpiryMs);
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) return false;
  const result = await tcw.requestPermissions(permissions, { expiryMs });
  return result.approved && sameSession() && tcw.hasPermissions(permissions);
}
