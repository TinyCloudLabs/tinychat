import express, { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import type { DelegationCache, DelegationStore } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { backendDelegationPolicyHash } from "../manifest.js";
import { parseStoredGrant, verifyTranscriptWriterGrant } from "../delegation-verify.js";
import { activateVerifiedDelegation, normalizeDid } from "../portable-delegation.js";
import { TenantCoordinator } from "../services/calendar-autojoin-store.js";

export const MAX_SERIALIZED_DELEGATION_BYTES = 64 * 1024;
const MAX_SIWE_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;

interface DelegationRoutesConfig {
  backendDid: string;
  configuredHost: string;
  eligibility: (address: string) => boolean;
  schemaMissing?: (address: string) => Promise<boolean> | boolean;
  store: Pick<DelegationStore, "store" | "load" | "remove">;
  cache: Pick<DelegationCache, "get" | "set" | "evict">;
  authMiddleware: RequestHandler;
  node: TinyCloudNode;
  coordinator?: TenantCoordinator;
}

export function createDelegationRouter(config: DelegationRoutesConfig) {
  const router = Router();
  const coordinator = config.coordinator ?? new TenantCoordinator();
  const accepts = new Map<string, number[]>();
  const deps = { computeDelegationCid: config.node.computeDelegationCid.bind(config.node) };
  router.use(config.authMiddleware);

  router.get("/status", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const delivery = !config.eligibility(user.address) ? "disabled"
        : await config.schemaMissing?.(user.address) ? "schema_missing" : "enabled";
      const stored = await config.store.load(user.address);
      if (!stored) { res.json({ status: "none", expiresAt: null, verified: false, delivery }); return; }
      if (Date.parse(stored.expiresAt) <= Date.now()) {
        await config.store.remove(user.address);
        config.cache.evict(user.address);
        res.json({ status: "expired", expiresAt: stored.expiresAt, verified: false, delivery });
        return;
      }
      if (!storedDelegationMatchesBackend(stored, config.backendDid)) {
        await config.store.remove(user.address);
        config.cache.evict(user.address);
        res.json({ status: "stale", expiresAt: null, verified: false, delivery });
        return;
      }
      const result = await parseStoredGrant(user.address, stored.serialized, config, deps);
      if (!result.ok) {
        await config.store.remove(user.address);
        config.cache.evict(user.address);
        res.json({ status: "stale", expiresAt: null, verified: false, delivery });
        return;
      }
      res.json({ status: "active", expiresAt: result.verified.expiresAt.toISOString(), verified: true, delivery });
    } catch {
      res.status(503).json({ error: "unavailable" });
    }
  });

  // Eligibility and the per-address quota precede the first read of the POST body.
  router.post("/", (req, res, next) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!config.eligibility(user.address)) { res.status(403).json({ error: "delivery_disabled" }); return; }
    next();
  }, (req, res, next) => {
    const address = req.user!.address.toLowerCase();
    const now = Date.now();
    const recent = (accepts.get(address) ?? []).filter((time) => now - time < 3_600_000);
    if (recent.length >= 6) { res.status(429).json({ error: "delegation_rate_limited" }); return; }
    recent.push(now);
    accepts.set(address, recent);
    next();
  }, express.json({ limit: "96kb" }), async (req: Request, res: Response) => {
    const address = req.user!.address;
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
      incoming = await verifyTranscriptWriterGrant({ serialized, siwe, signature, address, backendDid: config.backendDid, configuredHost: config.configuredHost }, deps);
    } catch { res.status(400).json({ error: "invalid_delegation" }); return; }
    if (!incoming.ok) { res.status(400).json({ error: incoming.code }); return; }
    const envelope = JSON.stringify({ format: "tinychat.transcript-writer-grant", v: 1, delegation: serialized, siwe, signature });
    try {
      const result = await coordinator.run(address, async () => {
        const stored = await config.store.load(address);
        if (stored && storedDelegationMatchesBackend(stored, config.backendDid)) {
          const previous = await parseStoredGrant(address, stored.serialized, config, deps);
          if (previous.ok && incoming.verified.expiresAt.getTime() - previous.verified.expiresAt.getTime() < 3_600_000) {
            return { expiresAt: previous.verified.expiresAt.toISOString() };
          }
        }
        const access = await activateVerifiedDelegation(config.node, incoming.verified, { host: config.configuredHost, beforeNodeWrite: async () => {} });
        const expiresAt = incoming.verified.expiresAt.toISOString();
        await config.store.store(address, envelope, {
          expiresAt, actions: [], path: "", policyHash: backendDelegationPolicyHash(config.backendDid),
          delegateDid: config.backendDid, resources: incoming.verified.resources,
        });
        config.cache.set(address, access);
        return { expiresAt };
      });
      res.json({ status: "active", expiresAt: result.expiresAt, verified: true, delivery: "enabled" });
    } catch {
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
    try {
      await config.store.remove(user.address);
      config.cache.evict(user.address);
      res.json({ status: "none", expiresAt: null });
    } catch { res.status(503).json({ error: "unavailable" }); }
  });
  return router;
}

function storedDelegationMatchesBackend(
  stored: { policyHash?: string; delegateDid?: string },
  backendDid: string,
): boolean {
  return (
    stored.policyHash === backendDelegationPolicyHash(backendDid) &&
    typeof stored.delegateDid === "string" &&
    normalizeDid(stored.delegateDid) === normalizeDid(backendDid)
  );
}


function requireUser(req: Request, res: Response): { address: string } | null {
  if (!req.user) {
    res
      .status(401)
      .json({ error: "unauthenticated", message: "Authentication required" });
    return null;
  }
  return req.user;
}
