// Background-safe KV delegation renewal: narrow an existing threads grant without opening owner approval.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import { serializePortableDelegation, toPortableDelegation } from "../lib/agentDelegation";

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const currentSession = () => new SessionStore("xyz.tinycloud.tinychat:session");
let active: { owner: string; token: string; until: number } | undefined;
export async function ensureBotHistoryGrant(tcw: TinyCloudWeb): Promise<void> {
  const sessions = currentSession();
  const token = sessions.getToken();
  const address = sessions.getAddress()?.toLowerCase();
  if (!token || !address) throw new Error("history_signed_out");
  if (active?.owner === address && active.token === token && active.until > Date.now()) return;
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
  const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(session.siwe)?.[1] ?? "");
  const lifetime = Math.min(7 * 86_400_000, expires - Date.now());
  if (!Number.isFinite(lifetime) || lifetime < 60_000) throw new Error("history_session_expired");
  // Check authority before delegateTo, which could otherwise try runtime permission escalation.
  const permissions = [{ service: "tinycloud.kv", space: "applications", skipPrefix: true, path: `xyz.tinycloud.tinychat/threads/bots/v1/${id}/`, actions: ["get", "put"] }];
  if (!tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
  const result = await tcw.delegateTo(backendDid, permissions, { expiry: lifetime });
  if (result.prompted) throw new Error("history_unexpected_approval");
  const portable = toPortableDelegation(result.delegation, address, 1, tcw.hosts[0] ?? "https://tee.node.tinycloud.xyz");
  if (currentSession().getToken() !== token || currentSession().getAddress()?.toLowerCase() !== address) throw new Error("history_session_changed");
  const accepted = await fetch(`${base}/api/bots/history/grant`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ serialized: await serializePortableDelegation(portable), siwe: session.siwe, signature: session.signature }), signal: AbortSignal.timeout(10_000) });
  if (!accepted.ok) throw new Error("history_grant_unavailable");
  active = { owner: address, token, until: Date.now() + Math.min(lifetime / 2, 3_600_000) };
}

export async function botHistoryEnabled(): Promise<boolean> {
  const token = currentSession().getToken();
  if (!token) return false;
  const status = await fetch(`${base}/api/bots/history/status`, { headers: { authorization: `Bearer ${token}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (status.status === 404) return false;
  if (!status.ok) throw new Error("history_status_unavailable");
  return true;
}
