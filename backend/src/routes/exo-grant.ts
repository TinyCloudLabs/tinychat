import express, { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { EXO_SYNC_GRANT_KIND } from "@tinyboilerplate/server";
import type { DelegationStore } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { backendDelegationPolicyHash } from "../manifest.js";
import { evictStoredGrantVerification, parseStoredGrant, verifyTranscriptWriterGrant } from "../delegation-verify.js";
import { activateVerifiedDelegation, DelegationActivationError } from "../portable-delegation.js";
import { TenantCoordinator } from "../services/calendar-autojoin-store.js";
import {
  MAX_SERIALIZED_DELEGATION_BYTES,
  MAX_SIGNATURE_BYTES,
  MAX_SIWE_BYTES,
  requireUser,
  storedDelegationMatchesBackend,
} from "./delegations.js";

const POLICY = "exo-sync" as const;

export interface ExoGrantRoutesConfig {
  backendDid: string;
  configuredHost: string;
  store: Pick<DelegationStore, "store" | "load" | "remove">;
  authMiddleware: RequestHandler;
  node: TinyCloudNode;
  coordinator?: TenantCoordinator;
}

/**
 * Exo sync grant: `GET | POST | DELETE /api/exo/v1/grant`. Mounted only while the exo flag is
 * exactly "true". Each route acts on the session owner's record only. The grant reaches the two
 * exo KV prefixes and nothing else; the verifier enforces that under the "exo-sync" policy.
 *
 * DELETE removes the stored record. It does not revoke the delegation on the node: a removed
 * grant stays valid there until it expires, so the owner revokes it at the node.
 */
export function createExoGrantRouter(config: ExoGrantRoutesConfig) {
  const router = Router();
  const coordinator = config.coordinator ?? new TenantCoordinator();
  const accepts = new Map<string, number[]>();
  const deps = { computeDelegationCid: config.node.computeDelegationCid.bind(config.node) };
  const parseOptions = { backendDid: config.backendDid, configuredHost: config.configuredHost, policy: POLICY };
  router.use(config.authMiddleware);

  router.get("/", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const address = user.address.toLowerCase();
    try {
      const result = await coordinator.run(address, async () => {
        const stored = await config.store.load(address);
        if (!stored) return { status: "none", expiresAt: null, verified: false };
        if (Date.parse(stored.expiresAt) <= Date.now()) {
          await removeIfUnchanged(address, stored.serialized);
          return { status: "expired", expiresAt: stored.expiresAt, verified: false };
        }
        if (!storedDelegationMatchesBackend(stored, config.backendDid)) {
          await removeIfUnchanged(address, stored.serialized);
          return { status: "stale", expiresAt: null, verified: false };
        }
        const verified = await parseStoredGrant(address, stored.serialized, parseOptions, deps);
        if (!verified.ok) {
          await removeIfUnchanged(address, stored.serialized);
          return { status: "stale", expiresAt: null, verified: false };
        }
        return { status: "active", expiresAt: verified.verified.expiresAt.toISOString(), verified: true };
      });
      res.json(result);
    } catch {
      res.status(503).json({ error: "unavailable" });
    }
  });

  function invalidateGrant(address: string, envelope?: string): void {
    if (envelope) evictStoredGrantVerification(address, envelope, config.backendDid, config.configuredHost, POLICY);
  }

  async function removeIfUnchanged(address: string, envelope: string): Promise<void> {
    if ((await config.store.load(address))?.serialized !== envelope) return;
    await config.store.remove(address);
    invalidateGrant(address, envelope);
  }

  // The per-address quota precedes the first read of the POST body.
  router.post("/", (req, res, next) => {
    const user = requireUser(req, res);
    if (!user) return;
    const address = user.address.toLowerCase();
    const now = Date.now();
    const recent = (accepts.get(address) ?? []).filter((time) => now - time < 3_600_000);
    if (recent.length >= 6) { res.status(429).json({ error: "delegation_rate_limited" }); return; }
    recent.push(now);
    accepts.set(address, recent);
    next();
  }, express.json({ limit: "96kb" }), async (req: Request, res: Response) => {
    const address = req.user!.address.toLowerCase();
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) { res.status(400).json({ error: "invalid_body" }); return; }
    const { serialized, siwe, signature } = body as Record<string, unknown>;
    if (typeof serialized !== "string" || !serialized || typeof siwe !== "string" || !siwe || typeof signature !== "string" || !signature) {
      res.status(400).json({ error: "invalid_body" }); return;
    }
    if (Buffer.byteLength(serialized) > MAX_SERIALIZED_DELEGATION_BYTES || Buffer.byteLength(siwe) > MAX_SIWE_BYTES || Buffer.byteLength(signature) > MAX_SIGNATURE_BYTES) {
      res.status(400).json({ error: "bundle_too_large" }); return;
    }
    let incoming;
    try {
      incoming = await verifyTranscriptWriterGrant({ serialized, siwe, signature, address, backendDid: config.backendDid, configuredHost: config.configuredHost, policy: POLICY }, deps);
    } catch { res.status(400).json({ error: "invalid_delegation" }); return; }
    if (!incoming.ok) { res.status(400).json({ error: incoming.code }); return; }
    const envelope = JSON.stringify({ format: EXO_SYNC_GRANT_KIND.envelopeFormat, v: 1, delegation: serialized, siwe, signature });
    try {
      const result = await coordinator.run(address, async () => {
        const stored = await config.store.load(address);
        if (stored && storedDelegationMatchesBackend(stored, config.backendDid)) {
          const previous = await parseStoredGrant(address, stored.serialized, parseOptions, deps);
          if (previous.ok && incoming.verified.expiresAt.getTime() - previous.verified.expiresAt.getTime() < 3_600_000) {
            return { expiresAt: previous.verified.expiresAt.toISOString() };
          }
        }
        await activateVerifiedDelegation(config.node, incoming.verified, { host: config.configuredHost, beforeNodeWrite: async () => {} });
        const expiresAt = incoming.verified.expiresAt.toISOString();
        await config.store.store(address, envelope, {
          expiresAt, actions: [], path: "", policyHash: backendDelegationPolicyHash(config.backendDid),
          delegateDid: config.backendDid, resources: incoming.verified.resources,
        });
        invalidateGrant(address, stored?.serialized);
        return { expiresAt };
      });
      res.json({ status: "active", expiresAt: result.expiresAt, verified: true });
    } catch (error) {
      // The node refused the grant itself: a rejection, not an outage, so the browser backs off.
      if (error instanceof DelegationActivationError && (error.status === 401 || error.status === 403)) {
        res.status(403).json({ error: "delegation_rejected" });
        return;
      }
      res.status(503).json({ error: "unavailable" });
    }
  });

  router.use((error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
    if (error instanceof SyntaxError || (typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed")) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    next(error);
  });

  router.delete("/", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const address = user.address.toLowerCase();
    try {
      await coordinator.run(address, async () => {
        const stored = await config.store.load(address);
        await config.store.remove(address);
        invalidateGrant(address, stored?.serialized);
      });
      res.json({ status: "none", expiresAt: null });
    } catch { res.status(503).json({ error: "unavailable" }); }
  });
  return router;
}
