// Main's read access to the owner's data: the settings API and the delegation the owner's browser signs for it.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import { serializePortableDelegation, toPortableDelegation } from "../lib/agentDelegation";

import { BotsError, BotsRouteMissing } from "./botsApi";
import { READ_AREAS, readAreaPermissions, type ReadArea } from "./trustbotReadAreas";

export type ReadAreaState = "off" | "on" | "ended";

export interface ReadSettings {
  serviceDid: string;
  /** When the signed grant ends, in ms since the epoch; null when there is none. */
  expiresAt: number | null;
  areas: Record<ReadArea, ReadAreaState>;
}

export interface ReadGrant {
  serialized: string;
  siwe: string;
  signature: string;
}

const MAX_LIFETIME_MS = 7 * 86_400_000;
const MIN_LIFETIME_MS = 60_000;
const STATES: readonly ReadAreaState[] = ["off", "on", "ended"];

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const currentSession = () => new SessionStore("xyz.tinycloud.tinychat:session");

function grantLifetime(siwe: string): number {
  const expires = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(siwe)?.[1] ?? "");
  const lifetime = Math.min(MAX_LIFETIME_MS, expires - Date.now());
  if (!Number.isFinite(lifetime) || lifetime < MIN_LIFETIME_MS) throw new Error("read_session_expired");
  return lifetime;
}

function toReadSettings(payload: unknown): ReadSettings {
  const value = (payload ?? {}) as { serviceDid?: unknown; expiresAt?: unknown; areas?: Record<string, unknown> };
  if (typeof value.serviceDid !== "string" || (value.expiresAt !== null && typeof value.expiresAt !== "number")) throw new BotsError("failed");
  const areas = {} as Record<ReadArea, ReadAreaState>;
  for (const area of Object.keys(READ_AREAS) as ReadArea[]) {
    const state = value.areas?.[area];
    areas[area] = STATES.includes(state as ReadAreaState) ? state as ReadAreaState : "off";
  }
  return { serviceDid: value.serviceDid, expiresAt: value.expiresAt, areas };
}

async function request(method: "GET" | "PUT", path: string, body?: unknown): Promise<ReadSettings> {
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
  return toReadSettings(await response.json().catch(() => null));
}

/** Main's read settings; throws BotsRouteMissing when the account has no such feature. */
export function readSettings(): Promise<ReadSettings> {
  return request("GET", "/api/bots/main/reads");
}

/** Turns one area on (with a grant covering every area that will be on) or off. */
export async function setReadArea(area: ReadArea, enabled: boolean, grant?: ReadGrant): Promise<ReadSettings> {
  if (enabled && !grant) throw new Error("read_grant_missing");
  return request("PUT", `/api/bots/main/reads/${area}`, enabled ? { enabled: true, grant } : { enabled: false });
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
