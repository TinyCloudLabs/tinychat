import type { TinyCloudWeb, PermissionEntry } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { APP_NAME } from "../lib/homeSite";
import { openkeyPasskeysSupported } from "../lib/openkeyPasskeys";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import { botsApi } from "./botsApi";
import { MAIN_BOT_NAME } from "./botsStrings";

export function botHistoryOwnerPermissions(address: string): PermissionEntry[] {
  return [{ service: "tinycloud.encryption", path: encryptionNetworkId(address), skipPrefix: true,
    actions: ["network.create", "decrypt"], description: `Set up encryption and read ${MAIN_BOT_NAME}'s chat history in your TinyCloud.` }];
}

/** The cause of an owner's decline of the encryption request. */
export const HISTORY_DECLINED = "history_approval_declined";
export const isHistoryDeclined = (cause: unknown): boolean => cause instanceof Error && cause.message === HISTORY_DECLINED;

// The owner who declined the request in this page session: no further request is made until they ask for it.
let declined: string | undefined;
/** Forgets the decline, so the next authorization asks again (the "Review request" button). */
export const clearHistoryDecline = (): void => { declined = undefined; };

/** Foreground only: first bot use/history read. Background renewal never calls this. */
export async function authorizeBotHistory(tcw: TinyCloudWeb, connect = connectWallet, status = botsApi.getBotsStatus): Promise<void> {
  if (!(await status()).enabled) throw new Error("history_disabled");
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const permissions = botHistoryOwnerPermissions(session.address);
  if (!tcw.hasPermissions(permissions)) {
    const owner = session.address.toLowerCase();
    if (declined === `${owner}:${session.sessionKey}`) throw new Error(HISTORY_DECLINED);
    const chainId = session.chainId;
    const sessionKey = session.sessionKey;
    // session() returns fresh snapshots; bind the flow to the owner and session key, not the wrapper object.
    const sameSession = () => {
      const current = tcw.session();
      return current?.address.toLowerCase() === owner && current.chainId === chainId && current.sessionKey === sessionKey;
    };
    // Reconnect on this page so a restored session has an owner signer. The backend cannot initiate this flow.
    const connected = await connect({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
    if (connected.address.toLowerCase() !== owner || !sameSession()) throw new Error("history_owner_changed");
    tcw.setRuntimePermissionSigner({ signMessage: async message => (await connected.openkey.signMessage({ message })).signature });
    const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
    const expiryMs = expires - Date.now();
    if (!Number.isFinite(expiryMs) || expiryMs <= 0) throw new Error("history_session_expired");
    const result = await tcw.requestPermissions(permissions, { expiryMs });
    if (!result.approved) {
      declined = `${owner}:${sessionKey}`;
      throw new Error(HISTORY_DECLINED);
    }
    if (!sameSession() || !tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
  }
  await tcw.ensureEncryptionNetwork();
}
