// Telegram has its own explicit OpenKey consent and owner -> session -> reader proof chain.
// Never widen One's session manifest or reuse the primary session's proof for this grant (TC-3314).
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { APP_NAME } from "../lib/homeSite";
import { openkeyPasskeysSupported } from "../lib/openkeyPasskeys";
import { ephemeralAgentSdkConfig, serializePortableDelegation, toPortableDelegation } from "../lib/agentDelegation";
import { readAreaPermissions } from "./trustbotReadAreas";
import { BOT_GRANT_MAX_LIFETIME_MS } from "./botGrantLifetime";
import type { ReadGrant } from "./trustbotReadGrant";

export async function mintTelegramReadGrant(owner: TinyCloudWeb, serviceDid: string): Promise<ReadGrant> {
  const original = owner.session();
  if (!original) throw new Error("read_session_missing");
  const sameOwnerSession = () => {
    const session = owner.session();
    return session?.address.toLowerCase() === original.address.toLowerCase() && session.sessionKey === original.sessionKey;
  };
  const connected = await connectWallet({ appName: APP_NAME, host: import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so", passkeysSupported: openkeyPasskeysSupported() });
  if (!sameOwnerSession() || connected.address.toLowerCase() !== original.address.toLowerCase()) throw new Error("read_session_changed");
  // The SDK touches HTMLElement at module load; keep this browser-only initialization lazy.
  const { TinyCloudWeb, BrowserSessionStorage } = await import("@tinycloud/web-sdk");
  const memory = new Map<string, string>();
  const storage: Storage = { get length() { return memory.size; }, clear: () => memory.clear(), getItem: key => memory.get(key) ?? null, key: i => [...memory.keys()][i] ?? null, removeItem: key => { memory.delete(key); }, setItem: (key, value) => { memory.set(key, value); } };
  const permissions = readAreaPermissions(["telegram"]);
  const consent = new TinyCloudWeb({
    ...ephemeralAgentSdkConfig({ web3Provider: connected.web3Provider, sessionStorage: new BrowserSessionStorage({ storage }), tinycloudHosts: owner.hosts,
      manifest: { manifest_version: 1, app_id: "xyz.tinycloud.tinychat", name: "TrustBot", defaults: false, permissions } }),
    sessionExpirationMs: BOT_GRANT_MAX_LIFETIME_MS,
    autoCreateSpace: false,
  });
  try {
    await consent.signIn();
    const session = consent.session();
    if (!sameOwnerSession() || session?.address.toLowerCase() !== original.address.toLowerCase() || !session.siwe || !session.signature) throw new Error("read_session_changed");
    const result = await consent.delegateTo(serviceDid, permissions, { expiry: BOT_GRANT_MAX_LIFETIME_MS - 60_000 });
    if (result.prompted || !sameOwnerSession()) throw new Error("read_session_changed");
    const portable = toPortableDelegation(result.delegation, session.address, session.chainId, owner.hosts[0] ?? "https://tee.node.tinycloud.xyz");
    return { serialized: await serializePortableDelegation(portable), siwe: session.siwe, signature: session.signature };
  } finally { try { consent.cleanup(); } finally { memory.clear(); } }
}
