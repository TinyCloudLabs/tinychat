import type { TinyCloudWeb, PermissionEntry } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { APP_NAME } from "../lib/homeSite";
import { openkeyPasskeysSupported } from "../lib/openkeyPasskeys";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import { botsApi } from "./botsApi";

export function botHistoryOwnerPermissions(address: string): PermissionEntry[] {
  return [{ service: "tinycloud.encryption", path: encryptionNetworkId(address), skipPrefix: true,
    actions: ["network.create", "decrypt"], description: "Set up encryption and read Main's chat history in your TinyCloud." }];
}

/** Foreground only: first bot use/history read. Background renewal never calls this. */
export async function authorizeBotHistory(tcw: TinyCloudWeb, connect = connectWallet, status = botsApi.getBotsStatus): Promise<void> {
  if (!(await status()).enabled) throw new Error("history_disabled");
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const permissions = botHistoryOwnerPermissions(session.address);
  if (!tcw.hasPermissions(permissions)) {
    const owner = session.address.toLowerCase();
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
    if (!result.approved) throw new Error("history_approval_declined");
    if (!sameSession() || !tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
  }
  await tcw.ensureEncryptionNetwork();
}
