// One's OpenKey step-up for a framed app's request, on One's own page (pattern: bots/historyAuthorization.ts).

import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { APP_NAME } from "../lib/homeSite";
import { openkeyPasskeysSupported } from "../lib/openkeyPasskeys";
import { bindRuntimeSigner, requestPermissionsDeclared, type OpenKeySignerConnection } from "../lib/openKeySigner";

/** The slice of OpenKey's connect the step-up uses: the owner's address, OpenKey's key type and a byte-exact message signer. */
export type StepUpConnect = (options: Parameters<typeof connectWallet>[0]) => Promise<{ address: string } & OpenKeySignerConnection>;

/**
 * Connects OpenKey for `session`'s owner and binds its signer to `tcw` (see `bindRuntimeSigner`: declared OpenKey only
 * for an OpenKey-managed key, so OpenKey's sign screen is then the only ask). Throws when the owner or session changed
 * underneath. Resolves a check that the session is still the same one, and whether the signer was declared.
 */
export async function bindOpenKeySigner(
  tcw: TinyCloudWeb,
  session: NonNullable<ReturnType<TinyCloudWeb["session"]>>,
  connect: StepUpConnect = connectWallet,
): Promise<{ sameSession: () => boolean; declared: boolean }> {
  const owner = session.address.toLowerCase();
  const { chainId, sessionKey } = session;
  const sameSession = () => {
    const current = tcw.session();
    return current?.address.toLowerCase() === owner && current.chainId === chainId && current.sessionKey === sessionKey;
  };
  const connected = await connect({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
  if (connected.address.toLowerCase() !== owner || !sameSession()) throw new Error("one_apps_owner_changed");
  return { sameSession, declared: bindRuntimeSigner(tcw, connected) };
}

/**
 * Asks OpenKey for `permissions` (one `requestPermissions` call; the SDK signs once per space) and resolves true only
 * when this same session now holds all of them. Throws when the owner or session changed underneath.
 */
export async function stepUpForApp(tcw: TinyCloudWeb, permissions: PermissionEntry[], connect: StepUpConnect = connectWallet): Promise<boolean> {
  const session = tcw.session();
  if (!session) return false;
  const { sameSession, declared } = await bindOpenKeySigner(tcw, session, connect);
  const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
  const expiryMs = expires - Date.now();
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) return false;
  const result = await requestPermissionsDeclared(tcw, permissions, { expiryMs }, declared);
  return result.approved && sameSession() && tcw.hasPermissions(permissions);
}
