// Background-safe KV delegation renewal: narrow an existing threads grant without opening owner approval.
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import { serializePortableDelegation, toPortableDelegation } from "../lib/agentDelegation";
import { BOT_GRANT_MAX_LIFETIME_MS, sessionAuthorityEnd } from "./botGrantLifetime";

import { botHistoryDirectory, SIBLING_BOT_KEY } from "./botHistoryPath";

export class BotHistoryApprovalNeeded extends Error {
  constructor() {
    super("history_approval_needed");
    this.name = "BotHistoryApprovalNeeded";
  }
}

function grantPermissions(path: string): PermissionEntry[] {
  return [{ service: "tinycloud.kv", space: "applications", skipPrefix: true, path, actions: ["get", "put"] }];
}

/** Seven days at most, and never past the session's signed end or the renewed end its backend bearer carries. */
function grantLifetime(siwe: string, bearer: string | null): number {
  const lifetime = Math.min(BOT_GRANT_MAX_LIFETIME_MS, sessionAuthorityEnd(siwe, bearer) - Date.now());
  if (!Number.isFinite(lifetime) || lifetime < 60_000) throw new Error("history_session_expired");
  return lifetime;
}

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const currentSession = () => new SessionStore("xyz.tinycloud.tinychat:session");
let active: { owner: string; token: string; untilByBot: Map<string, number> } | undefined;

function grantCache(owner: string, token: string) {
  if (active?.owner !== owner || active.token !== token) active = { owner, token, untilByBot: new Map() };
  return active.untilByBot;
}
export async function ensureBotHistoryGrant(tcw: TinyCloudWeb): Promise<void> {
  const sessions = currentSession();
  const token = sessions.getToken();
  const address = sessions.getAddress()?.toLowerCase();
  if (!token || !address) throw new Error("history_signed_out");
  const cached = grantCache(address, token);
  if ((cached.get("main") ?? 0) > Date.now()) return;
  const headers = { authorization: `Bearer ${token}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE };
  const status = await fetch(`${base}/api/bots/history/status`, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (status.status === 404) return; // history slice is dark
  if (!status.ok) throw new Error("history_unavailable");
  const { backendDid } = await status.json() as { backendDid: string };
  if (!/^did:pkh:eip155:1:0x[a-fA-F0-9]{40}$/.test(backendDid)) throw new Error("history_signer_invalid");
  const owner = `did:pkh:eip155:1:${address}`;
  const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner))), b => b.toString(16).padStart(2, "0")).join("");
  const session = tcw.session();
  if (!session?.siwe || !session.signature) throw new Error("history_session_missing");
  const lifetime = grantLifetime(session.siwe, token);
  // Check authority before delegateTo, which could otherwise try runtime permission escalation.
  const permissions = grantPermissions(`xyz.tinycloud.tinychat/threads/bots/v1/${id}/`);
  if (!tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
  const result = await tcw.delegateTo(backendDid, permissions, { expiry: lifetime });
  if (result.prompted) throw new Error("history_unexpected_approval");
  const portable = toPortableDelegation(result.delegation, address, 1, tcw.hosts[0] ?? "https://tee.node.tinycloud.xyz");
  if (currentSession().getToken() !== token || currentSession().getAddress()?.toLowerCase() !== address) throw new Error("history_session_changed");
  const accepted = await fetch(`${base}/api/bots/history/grant`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ serialized: await serializePortableDelegation(portable), siwe: session.siwe, signature: session.signature }), signal: AbortSignal.timeout(10_000) });
  if (!accepted.ok) throw new Error("history_grant_unavailable");
  cached.set("main", Date.now() + Math.min(lifetime / 2, 3_600_000));
}

/** Mints from the active session's existing authority. Also used by the opt-in restored-session QA runner. */
export async function mintSiblingHistoryGrant(tcw: TinyCloudWeb, backendDid: string, address: string, botKey: string) {
  if (!SIBLING_BOT_KEY.test(botKey)) throw new Error("history_bot_key_invalid");
  if (!/^did:pkh:eip155:1:0x[a-fA-F0-9]{40}$/.test(backendDid)) throw new Error("history_signer_invalid");
  const permissions = grantPermissions(await botHistoryDirectory(address, botKey));
  const session = tcw.session();
  if (!session || session.address.toLowerCase() !== address.toLowerCase() || session.chainId !== 1) {
    throw new Error("history_session_missing");
  }
  if (!session.siwe || !session.signature || !tcw.hasPermissions(permissions)) throw new BotHistoryApprovalNeeded();
  const host = tcw.hosts[0];
  if (!host) throw new Error("history_node_missing");
  const lifetime = grantLifetime(session.siwe, currentSession().getToken());
  const result = await tcw.delegateTo(backendDid, permissions, { expiry: lifetime, forceWalletSign: false }).catch((error: unknown) => {
    // The web SDK may carry its own copy of the SDK error class.
    if (error instanceof Error && error.name === "PermissionNotInManifestError") throw new BotHistoryApprovalNeeded();
    throw error;
  });
  if (result.prompted) throw new BotHistoryApprovalNeeded();
  const portable = toPortableDelegation(result.delegation, address, 1, host);
  return { envelope: { serialized: await serializePortableDelegation(portable), siwe: session.siwe, signature: session.signature }, lifetime };
}

/** The caller supplies a sibling key from the roster. S4 owns when to invoke this. */
export async function ensureSiblingHistoryGrant(tcw: TinyCloudWeb, botKey: string): Promise<void> {
  if (!SIBLING_BOT_KEY.test(botKey)) throw new Error("history_bot_key_invalid");
  const sessions = currentSession();
  const token = sessions.getToken();
  const address = sessions.getAddress()?.toLowerCase();
  if (!token || !address) throw new Error("history_signed_out");
  const cached = grantCache(address, token);
  if ((cached.get(botKey) ?? 0) > Date.now()) return;
  const headers = { authorization: `Bearer ${token}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE };
  const status = await fetch(`${base}/api/bots/history/status`, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!status.ok) throw new Error("history_unavailable");
  const { backendDid } = await status.json() as { backendDid: string };
  const { envelope, lifetime } = await mintSiblingHistoryGrant(tcw, backendDid, address, botKey);
  const latest = currentSession();
  if (latest.getToken() !== token || latest.getAddress()?.toLowerCase() !== address) throw new Error("history_session_changed");
  const accepted = await fetch(`${base}/api/bots/${botKey}/history/grant`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(envelope), signal: AbortSignal.timeout(10_000),
  });
  if (!accepted.ok) throw new Error("history_grant_unavailable");
  cached.set(botKey, Date.now() + Math.min(lifetime / 2, 3_600_000));
}

export async function botHistoryEnabled(): Promise<boolean> {
  const token = currentSession().getToken();
  if (!token) return false;
  const status = await fetch(`${base}/api/bots/history/status`, { headers: { authorization: `Bearer ${token}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (status.status === 404) return false;
  if (!status.ok) throw new Error("history_status_unavailable");
  return true;
}
