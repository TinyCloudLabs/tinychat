import { useEffect } from "react";
import type { TinyCloudWeb, PermissionEntry } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { APP_NAME } from "../lib/homeSite";
import { openkeyPasskeysSupported } from "../lib/openkeyPasskeys";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import {
  BOT_HISTORY_KEY_MAX_MS,
  BOT_HISTORY_LEGACY_MAX_MS,
  BOT_HISTORY_KEY_PATH,
  botHistoryKeyUrn,
  hasLegacyV1BotHistory,
  isCurrentHistorySession,
  publishBotHistoryKeyDescriptor,
  type SignedBotHistoryKeyEnvelope,
} from "./botHistoryKey";
import { botsApi } from "./botsApi";
import { resealLegacyBotHistory, type BotHistoryResealReport } from "./historyRead";

export const BOT_HISTORY_KEY_APPROVAL_DESCRIPTION = "Set up encryption and read chat history with your bots in your TinyCloud (up to 7 days).";

export const BOT_HISTORY_LEGACY_APPROVAL_DESCRIPTION = "Open your older encrypted chats with your bots, including any secrets in them, for 1 hour, to move them to their own encryption key.";

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

// Sessions whose older records have all been moved: the pass is skipped for them.
const resealPassDone = new Set<string>();

export interface AuthorizeBotHistoryOptions {
  /** Override v1 detection in tests; defaults to inspecting stored envelopes. */
  includeLegacyNetwork?: boolean;
  /** Override descriptor POST in tests. */
  postDescriptor?: (envelope: SignedBotHistoryKeyEnvelope) => Promise<void>;
  /** Receives the counts of the pass that moves older records to the exact key. Never includes plaintext or keys. */
  onResealReport?: (report: BotHistoryResealReport) => void;
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
  let connected: Awaited<ReturnType<typeof connectWallet>> | undefined;
  const requirePermissions = async (permissions: PermissionEntry[], maxMs = BOT_HISTORY_KEY_MAX_MS) => {
    if (tcw.hasPermissions(permissions)) return;
    if (declined === `${owner}:${session.sessionKey}`) throw new Error(HISTORY_DECLINED);
    assertSession();
    if (!connected) {
      const wallet = await connect({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
      if (wallet.address.toLowerCase() !== owner || !isCurrentHistorySession(tcw, session)) throw new Error("history_owner_changed");
      tcw.setRuntimePermissionSigner({ signMessage: async message => (await wallet.openkey.signMessage({ message })).signature });
      connected = wallet;
    }
    const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
    const remainingMs = expires - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error("history_session_expired");
    const result = await tcw.requestPermissions(permissions, { expiryMs: Math.min(remainingMs, maxMs) });
    assertSession();
    if (!result.approved) {
      declined = `${owner}:${session.sessionKey}`;
      throw new Error(HISTORY_DECLINED);
    }
    if (!tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
  };

  await requirePermissions(exact);
  if (!(await tcw.getEncryptionNetwork(networkId))) {
    await requirePermissions(network("network.create", BOT_HISTORY_KEY_APPROVAL_DESCRIPTION));
  }
  assertSession();
  await tcw.ensureEncryptionNetwork();
  assertSession();
  const legacy = network("decrypt", BOT_HISTORY_LEGACY_APPROVAL_DESCRIPTION);
  if (!tcw.hasPermissions(legacy) && (options.includeLegacyNetwork ?? await hasLegacyV1BotHistory(tcw))) {
    await requirePermissions(legacy, BOT_HISTORY_LEGACY_MAX_MS);
  }
  assertSession();
  const descriptor = await tcw.keys.ensureKey(BOT_HISTORY_KEY_PATH, { networkId });
  assertSession();
  await publishBotHistoryKeyDescriptor(tcw, descriptor, { post: options.postDescriptor });

  // While the decrypt grant is held, move every bot's older records to the exact key in one pass. A failure is
  // counted (and warned about by the pass), never thrown: reads still work for the grant's lifetime, and the
  // next authorization runs the pass again until it finishes with nothing left undone.
  const passKey = `${owner}:${session.sessionKey}`;
  if (options.includeLegacyNetwork !== false && tcw.hasPermissions(legacy) && !resealPassDone.has(passKey)) {
    try {
      const report = await resealLegacyBotHistory(tcw);
      if (report.failed.length === 0) resealPassDone.add(passKey);
      options.onResealReport?.(report);
    } catch {
      // The listing itself was unavailable: nothing was changed and nothing is marked done.
    }
  }
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

export function useBotHistoryDescriptorRenewal(tcw: TinyCloudWeb | null): void {
  useEffect(() => {
    if (!tcw) return;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void refreshBotHistoryKeyDescriptor(tcw).catch(() => {}).finally(() => { pending = false; });
    };
    const refreshWhenVisible = () => { if (!document.hidden) refresh(); };
    refresh();
    const timer = setInterval(refreshWhenVisible, 10 * 60_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [tcw]);
}
