import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import { BotsError, BotsRouteMissing } from "../botsApi";

export interface CourierPeer {
  handle: string;
  peerDid: string;
  status: "paired" | "expired";
  pairedAt: number;
  delegationExpiresAt: number;
}

export interface CourierPairRequest { artifact: string }
export interface CourierPairPending {
  acceptArtifact: string;
  pending: true;
  handle: string;
  pendingExpiresAt: number;
}
export type CourierPairResult = CourierPairPending | { peer: CourierPeer };
export interface CourierPeersApi {
  listPeers(): Promise<{ peers: CourierPeer[] }>;
  pairPeer(request: CourierPairRequest): Promise<CourierPairResult>;
  unpairPeer(handle: string): Promise<void>;
}

/** The peer's Courier version cannot complete the signed pairing exchange. */
export class CourierUpdateRequired extends BotsError {
  constructor() {
    super("failed");
    this.name = "CourierUpdateRequired";
  }
}

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;

function isPeer(value: unknown): value is CourierPeer {
  return typeof value === "object" && value !== null
    && "handle" in value && typeof value.handle === "string" && value.handle.length > 0
    && "peerDid" in value && typeof value.peerDid === "string" && value.peerDid.length > 0
    && "status" in value && (value.status === "paired" || value.status === "expired")
    && "pairedAt" in value && typeof value.pairedAt === "number" && Number.isFinite(value.pairedAt)
    && "delegationExpiresAt" in value && typeof value.delegationExpiresAt === "number" && Number.isFinite(value.delegationExpiresAt);
}

async function request(method: "GET" | "POST" | "DELETE", path: string, body?: CourierPairRequest): Promise<unknown> {
  const token = new SessionStore("xyz.tinycloud.tinychat:session").getToken();
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
  if (response.status === 426) throw new CourierUpdateRequired();
  if (response.status === 404) throw new BotsRouteMissing();
  if (!response.ok) throw new BotsError("failed");
  if (method === "DELETE") return;
  try { return await response.json(); } catch { throw new BotsError("failed"); }
}

const path = "/api/bots/main/courier/peers";

export const courierPeersApi: CourierPeersApi = {
  async listPeers() {
    const body = await request("GET", path);
    if (typeof body !== "object" || body === null || !("peers" in body)
      || !Array.isArray(body.peers) || !body.peers.every(isPeer)) throw new BotsError("failed");
    return { peers: body.peers };
  },
  async pairPeer(input) {
    const body = await request("POST", path, { artifact: input.artifact });
    if (typeof body !== "object" || body === null) throw new BotsError("failed");
    if ("pending" in body && body.pending === true) {
      if (!("acceptArtifact" in body) || typeof body.acceptArtifact !== "string" || !body.acceptArtifact
        || !("handle" in body) || typeof body.handle !== "string" || !body.handle
        || !("pendingExpiresAt" in body) || typeof body.pendingExpiresAt !== "number"
        || !Number.isFinite(body.pendingExpiresAt)) throw new BotsError("failed");
      return { acceptArtifact: body.acceptArtifact, pending: true, handle: body.handle, pendingExpiresAt: body.pendingExpiresAt };
    }
    if (!("peer" in body) || !isPeer(body.peer)) throw new BotsError("failed");
    return { peer: body.peer };
  },
  async unpairPeer(handle) {
    await request("DELETE", `${path}/${encodeURIComponent(handle)}`);
  },
};
