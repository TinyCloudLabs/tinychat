import type { Request, Response, Router } from "express";
import type { CourierRouterDeps } from "./bots-courier";

const HANDLE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const PEER_DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{1,200}$/;
const MAX_ARTIFACT = 64 * 1024;
const UNAVAILABLE = { error: "courier_unavailable" };

interface CourierPeerView {
  handle: string;
  peerDid: string;
  status: "paired" | "expired";
  pairedAt: number;
  delegationExpiresAt: number;
}

type PairingView = { peer: CourierPeerView } | { acceptArtifact: string; pending: true; handle: string; pendingExpiresAt: number };

const isTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isArtifact = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ARTIFACT && value.trim().length > 0;

/** Only public peer fields leave the backend, even if the service includes a delegation or key. */
function toPeer(value: unknown): CourierPeerView | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !("handle" in value) || !("peerDid" in value) || !("status" in value) || !("pairedAt" in value) || !("delegationExpiresAt" in value)) return null;
  const { handle, peerDid, status, pairedAt, delegationExpiresAt } = value;
  if (typeof handle !== "string" || !HANDLE.test(handle) || typeof peerDid !== "string" || !PEER_DID.test(peerDid) || (status !== "paired" && status !== "expired")) return null;
  if (!isTimestamp(pairedAt) || !isTimestamp(delegationExpiresAt) || delegationExpiresAt <= pairedAt) return null;
  return { handle, peerDid, status, pairedAt, delegationExpiresAt };
}

function toPairing(value: unknown): PairingView | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if ("pending" in value) {
    if (!("acceptArtifact" in value) || !("handle" in value) || !("pendingExpiresAt" in value)) return null;
    const { acceptArtifact, pending, handle, pendingExpiresAt } = value;
    if (pending !== true || "peer" in value || !isArtifact(acceptArtifact) || typeof handle !== "string" || !HANDLE.test(handle) || !isTimestamp(pendingExpiresAt)) return null;
    return { acceptArtifact, pending, handle, pendingExpiresAt };
  }
  const peer = "peer" in value ? toPeer(value.peer) : null;
  return peer ? { peer } : null;
}

/** Authentication and the feature flag are mounted by C1 before these handlers. Never rerun auth. */
export function mountCourierPairing(router: Router, deps: CourierRouterDeps): void {
  const { config, callBots } = deps;
  const ownerFor = (req: Request, res: Response): string | null => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return null; }
    if (!config.accountAllowed(req.user.address)) { res.status(404).json({ error: "not_found" }); return null; }
    return req.user.address;
  };

  router.get("/peers", async (req, res) => {
    const owner = ownerFor(req, res);
    if (!owner) return;
    try {
      const upstream = await callBots(owner, "GET", "/courier/peers");
      if (!upstream.ok) { res.status(502).json(UNAVAILABLE); return; }
      const payload: unknown = await upstream.json();
      if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !("peers" in payload) || !Array.isArray(payload.peers)) { res.status(502).json(UNAVAILABLE); return; }
      const peers: CourierPeerView[] = [];
      for (const value of payload.peers) {
        const peer = toPeer(value);
        if (!peer) { res.status(502).json(UNAVAILABLE); return; }
        peers.push(peer);
      }
      res.json({ peers });
    } catch {
      res.status(502).json(UNAVAILABLE);
    }
  });

  router.post("/peers", async (req, res) => {
    const owner = ownerFor(req, res);
    if (!owner) return;
    const body: unknown = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("artifact" in body) || !isArtifact(body.artifact)) { res.status(400).json({ error: "invalid" }); return; }
    try {
      const upstream = await callBots(owner, "POST", "/courier/peers", { artifact: body.artifact });
      if (!upstream.ok) {
        if (upstream.status === 400) res.status(400).json({ error: "invalid" });
        else if (upstream.status === 409) res.status(409).json({ error: "duplicate" });
        else if (upstream.status === 410) res.status(410).json({ error: "pending_expired" });
        else if (upstream.status === 426) res.status(426).json({ error: "courier_update_required" });
        else res.status(502).json(UNAVAILABLE);
        return;
      }
      const payload: unknown = await upstream.json();
      const pairing = toPairing(payload);
      if (!pairing) { res.status(502).json(UNAVAILABLE); return; }
      res.json(pairing);
    } catch {
      res.status(502).json(UNAVAILABLE);
    }
  });

  router.delete("/peers/:handle", async (req, res) => {
    const owner = ownerFor(req, res);
    if (!owner) return;
    const { handle } = req.params;
    const body: unknown = req.body;
    if (typeof handle !== "string" || !HANDLE.test(handle) || (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0))) { res.status(400).json({ error: "invalid" }); return; }
    try {
      const upstream = await callBots(owner, "DELETE", `/courier/peers/${encodeURIComponent(handle)}`);
      if (upstream.status !== 204) { res.status(502).json(UNAVAILABLE); return; }
      res.status(204).end();
    } catch {
      res.status(502).json(UNAVAILABLE);
    }
  });
}
