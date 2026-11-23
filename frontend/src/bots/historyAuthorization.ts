import type { TinyCloudWeb, PermissionEntry } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { APP_NAME } from "../lib/homeSite";
import { openkeyPasskeysSupported } from "../lib/openkeyPasskeys";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import {
  BOT_HISTORY_KEY_MAX_MS,
  BOT_HISTORY_KEY_PATH,
  botHistoryKeyUrn,
  hasLegacyV1BotHistory,
  isCurrentHistorySession,
  publishBotHistoryKeyDescriptor,
  type SignedBotHistoryKeyEnvelope,
} from "./botHistoryKey";
import { botsApi } from "./botsApi";
import { MAIN_BOT_NAME } from "./botsStrings";

/** Placeholder approval description for exact-key bot history access (listed in PR for copy review). */
export const BOT_HISTORY_KEY_APPROVAL_DESCRIPTION = `Set up encryption and read ${MAIN_BOT_NAME}'s chat history in your TinyCloud (up to 7 days).`;

/** Placeholder approval description for one-time legacy v1 read + reseal (listed in PR for copy review). */
export const BOT_HISTORY_LEGACY_APPROVAL_DESCRIPTION = `Read earlier ${MAIN_BOT_NAME} chat history in your TinyCloud so it can move to its own key (up to 7 days).`;

export function botHistoryOwnerPermissions(address: string): PermissionEntry[] {
  return [{
    service: "tinycloud.encryption",
    path: botHistoryKeyUrn(address),
    skipPrefix: true,
    actions: ["key.create", "decrypt"],
    description: BOT_HISTORY_KEY_APPROVAL_DESCRIPTION,
  }];
}

/** The cause of an owner's decline of the encryption request. */
export const HISTORY_DECLINED = "history_approval_declined";
export const isHistoryDeclined = (cause: unknown): boolean => cause instanceof Error && cause.message === HISTORY_DECLINED;

// The owner who declined the request in this page session: no further request is made until they ask for it.
let declined: string | undefined;
/** Forgets the decline, so the next authorization asks again (the "Review request" button). */
export const clearHistoryDecline = (): void => { declined = undefined; };

export interface AuthorizeBotHistoryOptions {
  /** Override v1 detection in tests; defaults to inspecting stored envelopes. */
  includeLegacyNetwork?: boolean;
  /** Override descriptor POST in tests. */
  postDescriptor?: (envelope: SignedBotHistoryKeyEnvelope) => Promise<void>;
}

/** Foreground only: first bot use/history read. Background renewal never calls this. */
export async function authorizeBotHistory(
  tcw: TinyCloudWeb,
  connect = connectWallet,
  status = botsApi.getBotsStatus,
  options: AuthorizeBotHistoryOptions = {},
): Promise<void> {
  if (!(await status()).enabled) throw new Error("history_disabled");
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const owner = session.address.toLowerCase();
  const assertSession = () => {
    if (!isCurrentHistorySession(tcw, session)) throw new Error("history_authority_missing");
  };
  const networkId = encryptionNetworkId(session.address, session.chainId ?? 1);
  const exact = botHistoryOwnerPermissions(session.address);
  const network = (action: string, description: string): PermissionEntry[] => [{
    service: "tinycloud.encryption", path: networkId, skipPrefix: true, actions: [action], description,
  }];
  const legacy = network("decrypt", BOT_HISTORY_LEGACY_APPROVAL_DESCRIPTION);
  const includeLegacy = !tcw.hasPermissions(legacy) && (options.includeLegacyNetwork ?? await hasLegacyV1BotHistory(tcw));
  const needsNetwork = !(await tcw.getEncryptionNetwork(networkId));
  assertSession();

  const requests = [
    ...(needsNetwork ? [network("network.create", BOT_HISTORY_KEY_APPROVAL_DESCRIPTION)] : []),
    exact,
    ...(includeLegacy ? [legacy] : []),
  ].filter(permissions => !tcw.hasPermissions(permissions));
  if (requests.length) {
    if (declined === `${owner}:${session.sessionKey}`) throw new Error(HISTORY_DECLINED);
    const connected = await connect({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
    if (connected.address.toLowerCase() !== owner || !isCurrentHistorySession(tcw, session)) throw new Error("history_owner_changed");
    tcw.setRuntimePermissionSigner({ signMessage: async message => (await connected.openkey.signMessage({ message })).signature });
    for (const permissions of requests) {
      const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
      const remainingMs = expires - Date.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error("history_session_expired");
      const result = await tcw.requestPermissions(permissions, { expiryMs: Math.min(remainingMs, BOT_HISTORY_KEY_MAX_MS) });
      assertSession();
      if (!result.approved) {
        declined = `${owner}:${session.sessionKey}`;
        throw new Error(HISTORY_DECLINED);
      }
      if (!tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
    }
  }
  await tcw.ensureEncryptionNetwork();
  assertSession();
  const descriptor = await tcw.keys.ensureKey(BOT_HISTORY_KEY_PATH, { networkId });
  assertSession();
  await publishBotHistoryKeyDescriptor(tcw, descriptor, { post: options.postDescriptor });
}

/** Renew a descriptor using a grant already held by this session. Called on sign-in and while signed in. */
export async function refreshBotHistoryKeyDescriptor(tcw: TinyCloudWeb): Promise<void> {
  const session = tcw.session();
  if (!session || !tcw.hasPermissions(botHistoryOwnerPermissions(session.address))) return;
  const descriptor = await tcw.keys.describeKey(BOT_HISTORY_KEY_PATH, {
    networkId: encryptionNetworkId(session.address, session.chainId ?? 1),
  });
  if (!descriptor || descriptor.state !== "active" || descriptor.kind !== "deletable" || !isCurrentHistorySession(tcw, session)) return;
  await publishBotHistoryKeyDescriptor(tcw, descriptor);
}
