// Main's read access to the owner's data: the settings API and the delegation the owner's browser signs for it.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import { serializePortableDelegation, toPortableDelegation } from "../lib/agentDelegation";
import { botGrantLifetime } from "./botGrantLifetime";

import { BotsError, BotsRouteMissing } from "./botsApi";
import { READ_AREAS, readAreaPermissions, type ReadArea } from "./trustbotReadAreas";

export type ReadAreaState = "off" | "on" | "ended";

export interface ReadSettings {
  serviceDid: string;
  /** When the signed grant ends, in ms since the epoch; null when there is none. */
  expiresAt: number | null;
  /** The stored grant, for the owner's own revoke at the node; null when there is none. */
  grantCid: string | null;
  areas: Record<ReadArea, ReadAreaState>;
}

/** What turning a read area on or off needs. */
export interface ReadAreaApi {
  readSettings(): Promise<ReadSettings>;
  setReadArea(area: ReadArea, enabled: boolean, grant?: ReadGrant): Promise<ReadSettings>;
  signReadGrant(serviceDid: string, areas: ReadArea[]): Promise<ReadGrant>;
  /** Revokes a grant the owner signed, at the node; throws when the node does not confirm it. */
  revokeReadGrant(cid: string): Promise<void>;
}

export interface ReadGrant {
  serialized: string;
  siwe: string;
  signature: string;
}

const STATES: readonly ReadAreaState[] = ["off", "on", "ended"];

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const currentSession = () => new SessionStore("xyz.tinycloud.tinychat:session");

function grantLifetime(siwe: string): number {
  const lifetime = botGrantLifetime(siwe);
  if (!Number.isFinite(lifetime) || lifetime < 60_000) throw new Error("read_session_expired");
  return lifetime;
}

function toReadSettings(payload: unknown): ReadSettings {
  const value = (payload ?? {}) as { serviceDid?: unknown; expiresAt?: unknown; grantCid?: unknown; areas?: Record<string, unknown> };
  if (typeof value.serviceDid !== "string" || (value.expiresAt !== null && typeof value.expiresAt !== "number")) throw new BotsError("failed");
  const areas = {} as Record<ReadArea, ReadAreaState>;
  for (const area of Object.keys(READ_AREAS) as ReadArea[]) {
    const state = value.areas?.[area];
    areas[area] = STATES.includes(state as ReadAreaState) ? state as ReadAreaState : "off";
  }
  return { serviceDid: value.serviceDid, expiresAt: value.expiresAt, grantCid: typeof value.grantCid === "string" ? value.grantCid : null, areas };
}

async function request(method: "GET" | "PUT", path: string, body?: unknown): Promise<unknown> {
  const token = currentSession().getToken();
  if (!token) throw new BotsError("signed_out");
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BotsError("failed");
  }
  if (response.status === 401) throw new BotsError("signed_out");
  if (response.status === 400) throw new BotsError("invalid");
  if (response.status === 404) throw new BotsRouteMissing();
  if (!response.ok) throw new BotsError("failed");
  return response.json().catch(() => null);
}

/** Main's read settings; throws BotsRouteMissing when the account has no such feature. */
export function readSettings(): Promise<ReadSettings> {
  return request("GET", "/api/bots/main/reads").then(toReadSettings);
}

/** Turns one area on (with a grant covering every area that will be on) or off. */
export async function setReadArea(area: ReadArea, enabled: boolean, grant?: ReadGrant): Promise<ReadSettings> {
  if (enabled && !grant) throw new Error("read_grant_missing");
  return request("PUT", `/api/bots/main/reads/${area}`, enabled ? { enabled: true, grant } : { enabled: false }).then(toReadSettings);
}

/** Revokes a read grant at the node, as the owner who signed it: the node takes a revocation only from them. */
export async function revokeReadGrant(tcw: TinyCloudWeb, cid: string): Promise<void> {
  const revoked = await tcw.revokeDelegation(cid);
  if (!revoked.ok) throw new Error("read_revoke_failed");
}

/** A revoke that fails leaves the grant to its end date (7 days at most); the change the owner asked for still happens. */
async function revokeQuietly(api: Pick<ReadAreaApi, "revokeReadGrant">, cid: string): Promise<void> {
  try { await api.revokeReadGrant(cid); } catch { /* the backend has deleted or replaced its copy either way */ }
}

async function replaceReadGrant(
  api: Pick<ReadAreaApi, "signReadGrant" | "revokeReadGrant">,
  saved: ReadSettings,
  areas: ReadArea[],
  store: (grant: ReadGrant) => Promise<ReadSettings>,
): Promise<ReadSettings> {
  const grant = await api.signReadGrant(saved.serviceDid, areas);
  const stored = await store(grant);
  if (saved.grantCid && saved.grantCid !== stored.grantCid) await revokeQuietly(api, saved.grantCid);
  return stored;
}

export function readAreasDueForRenewal(
  saved: ReadSettings, renewAfter: number, siwe: string, now = Date.now(),
): ReadArea[] {
  if (!saved.grantCid || saved.expiresAt === null) return [];
  const lifetime = botGrantLifetime(siwe, now);
  if (!Number.isFinite(lifetime) || lifetime < 60_000 ||
      Math.floor((now + lifetime) / 1000) * 1000 <= saved.expiresAt) return [];
  const areas = Object.keys(saved.areas) as ReadArea[];
  return areas.filter(area => saved.areas[area] === "ended" || (saved.areas[area] === "on" && now > renewAfter));
}

let renewing = false;

/** The Home renewal tick silently replaces a grant only when the current session can extend it. */
export async function ensureTrustBotReadGrant(tcw: TinyCloudWeb): Promise<boolean> {
  if (renewing) return false;
  renewing = true;
  try {
    const token = currentSession().getToken();
    if (!token) return false;
    const payload = await request("GET", "/api/bots/main/reads/renewal");
    const saved = toReadSettings(payload);
    const renewAfter = (payload as { renewAfter?: unknown }).renewAfter;
    const session = tcw.session();
    if (typeof renewAfter !== "number" || !session?.siwe || !session.signature ||
        currentSession().getToken() !== token) return false;
    const areas = readAreasDueForRenewal(saved, renewAfter, session.siwe);
    if (areas.length === 0) return false;
    await replaceReadGrant({
      signReadGrant: (did, areas) => signReadGrant(tcw, did, areas),
      revokeReadGrant: cid => revokeReadGrant(tcw, cid),
    }, saved, areas, grant => {
      if (currentSession().getToken() !== token) throw new Error("read_session_changed");
      return request("PUT", "/api/bots/main/reads/renewal", {
        enabled: true, grant, replaces: saved.grantCid,
      }).then(toReadSettings);
    });
    return true;
  } catch {
    return false;
  } finally {
    renewing = false;
  }
}

/**
 * Turns `area` on or off from the settings last read. On: signs one grant for every area that will be on, stores it,
 * then revokes the grant it replaced. Off: when no other area stays on, revokes the grant, then turns the area off.
 */
export async function changeReadArea(api: ReadAreaApi, saved: ReadSettings, area: ReadArea, enabled: boolean): Promise<ReadSettings> {
  const names = Object.keys(saved.areas) as ReadArea[];
  const others = names.filter((name) => name !== area && saved.areas[name] === "on");
  if (enabled) {
    const areas = names.filter(name => name === area || others.includes(name));
    return replaceReadGrant(api, saved, areas, grant => api.setReadArea(area, true, grant));
  }
  if (others.length === 0 && saved.grantCid) await revokeQuietly(api, saved.grantCid);
  return api.setReadArea(area, false);
}

/**
 * Signs one delegation to `serviceDid` covering the listed areas, from authority the session already holds. Refuses
 * rather than opening a wallet prompt, and refuses when the signed-in session changes while it signs.
 */
export async function signReadGrant(tcw: TinyCloudWeb, serviceDid: string, areas: ReadArea[]): Promise<ReadGrant> {
  if (!/^did:pkh:eip155:1:0x[a-fA-F0-9]{40}$/.test(serviceDid)) throw new Error("read_signer_invalid");
  const sessions = currentSession();
  const token = sessions.getToken();
  const address = sessions.getAddress()?.toLowerCase();
  if (!token || !address) throw new Error("read_signed_out");
  const session = tcw.session();
  if (!session?.siwe || !session.signature) throw new Error("read_session_missing");
  const lifetime = grantLifetime(session.siwe);
  const permissions = readAreaPermissions(areas);
  if (permissions.length === 0) throw new Error("read_areas_missing");
  // Check authority before delegateTo, which could otherwise try runtime permission escalation.
  if (!tcw.hasPermissions(permissions)) throw new Error("read_authority_missing");
  const result = await tcw.delegateTo(serviceDid, permissions, { expiry: lifetime });
  if (result.prompted) throw new Error("read_unexpected_approval");
  const portable = toPortableDelegation(result.delegation, address, 1, tcw.hosts[0] ?? "https://tee.node.tinycloud.xyz");
  const serialized = await serializePortableDelegation(portable);
  const latest = currentSession();
  if (latest.getToken() !== token || latest.getAddress()?.toLowerCase() !== address) throw new Error("read_session_changed");
  return { serialized, siwe: session.siwe, signature: session.signature };
}
