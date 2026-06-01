import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import type { ServerInfoPermission } from "@tinyboilerplate/core";
import type { DelegatedAccess, DelegationCache, DelegationStore } from "@tinyboilerplate/server";
import { DEFAULT_DELEGATION_EXPIRY_MS } from "@tinyboilerplate/core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  backendDelegationPolicyHash,
  backendDelegationResolvedPermissions,
  delegationCoversBackendPolicy,
} from "../manifest.js";
import {
  activatePortableDelegation,
  deserializePortableDelegationSet,
  extractPortableDelegationIdentity,
  extractPortableResources,
  normalizeAddress,
  normalizeDid,
  portableDelegationExpiry,
  type PortableDelegationSet,
} from "../portable-delegation.js";

interface DelegationRoutesConfig {
  backendDid: string;
  store: Pick<DelegationStore, "store" | "load" | "remove">;
  cache: Pick<DelegationCache, "get" | "set" | "evict">;
  authMiddleware: RequestHandler;
  node?: TinyCloudNode;
  deserializeDelegationSet?: (serialized: string) => PortableDelegationSet;
  activateDelegation?: (delegation: PortableDelegationSet) => Promise<DelegatedAccess>;
  extractResources?: (delegation: PortableDelegationSet) => ServerInfoPermission[];
  extractExpiry?: (delegation: PortableDelegationSet) => Date | null;
}

export function createDelegationRouter(config: DelegationRoutesConfig) {
  const router = Router();
  router.use(config.authMiddleware);

  router.get("/status", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const stored = await config.store.load(user.address);
    if (!stored) {
      res.json({ status: "none", expiresAt: null });
      return;
    }

    if (new Date(stored.expiresAt).getTime() <= Date.now()) {
      await config.store.remove(user.address);
      config.cache.evict(user.address);
      res.json({ status: "expired", expiresAt: stored.expiresAt });
      return;
    }

    if (!storedDelegationMatchesBackend(stored, config.backendDid)) {
      await config.store.remove(user.address);
      config.cache.evict(user.address);
      res.json({ status: "stale", expiresAt: null });
      return;
    }

    res.json({ status: "active", expiresAt: stored.expiresAt });
  });

  router.post("/", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { serialized } = req.body;
    if (typeof serialized !== "string" || serialized.length === 0) {
      res.status(400).json({
        error: "invalid_body",
        message: "Request body must include serialized delegation",
      });
      return;
    }

    try {
      const deserialize = config.deserializeDelegationSet ?? deserializePortableDelegationSet;
      const delegation = deserialize(serialized);
      const identity = extractPortableDelegationIdentity(delegation);
      if (!identity) {
        res.status(400).json({
          error: "invalid_delegation_identity",
          message: "Delegation does not expose a consistent owner and delegatee",
        });
        return;
      }

      if (normalizeAddress(identity.ownerAddress) !== normalizeAddress(user.address)) {
        res.status(400).json({
          error: "wrong_delegator",
          message: "Delegation owner does not match the authenticated user",
          expected: user.address,
          actual: identity.ownerAddress,
        });
        return;
      }

      if (normalizeDid(identity.delegateDID) !== normalizeDid(config.backendDid)) {
        res.status(400).json({
          error: "wrong_delegatee",
          message: "Delegation delegatee does not match the current backend DID",
          expected: config.backendDid,
          actual: identity.delegateDID,
        });
        return;
      }

      const resources = (config.extractResources ?? extractPortableResources)(delegation);

      if (!delegationCoversBackendPolicy(resources, config.backendDid)) {
        res.status(400).json({
          error: "insufficient_delegation",
          message: "Delegation does not cover the current backend policy",
          required: backendDelegationResolvedPermissions(config.backendDid),
        });
        return;
      }

      const activate =
        config.activateDelegation ??
        ((input: PortableDelegationSet) => {
          if (!config.node) throw new Error("TinyCloud node is required to activate delegations");
          return activatePortableDelegation(config.node, input);
        });
      const access = await activate(delegation);
      const expiry =
        (config.extractExpiry ?? portableDelegationExpiry)(delegation) ??
        new Date(Date.now() + DEFAULT_DELEGATION_EXPIRY_MS);
      const expiresAt = expiry.toISOString();

      await config.store.store(user.address, serialized, {
        expiresAt,
        actions: [],
        path: "",
        policyHash: backendDelegationPolicyHash(config.backendDid),
        delegateDid: config.backendDid,
        resources,
      });
      config.cache.set(user.address, access);
      res.json({ status: "active", expiresAt });
    } catch (error) {
      console.error("[delegations] failed to accept delegation:", error);
      res
        .status(400)
        .json({ error: "invalid_delegation", message: "Failed to process delegation" });
    }
  });

  router.delete("/", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    await config.store.remove(user.address);
    config.cache.evict(user.address);
    res.json({ status: "none", expiresAt: null });
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
    res.status(401).json({ error: "unauthenticated", message: "Authentication required" });
    return null;
  }
  return req.user;
}
