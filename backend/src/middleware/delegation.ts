import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { DelegationCache, DelegationStore } from "@tinyboilerplate/server";
import { backendDelegationPolicyHash } from "../manifest.js";
import {
  activatePortableDelegation,
  deserializePortableDelegationSet,
  normalizeDid,
} from "../portable-delegation.js";

interface DelegationMiddlewareConfig {
  node: TinyCloudNode;
  store: DelegationStore;
  cache: DelegationCache;
  backendDid: string;
}

export function createDelegationMiddleware(config: DelegationMiddlewareConfig) {
  const { node, store, cache, backendDid } = config;

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "unauthenticated", message: "Authentication required" });
      return;
    }

    const { address } = req.user;
    const cached = cache.get(address);
    if (cached) {
      const valid = await validateStoredDelegation(address, store, cache, backendDid);
      if (!valid.ok) {
        res.status(valid.status).json({ error: valid.error, message: valid.message });
        return;
      }
      req.delegatedAccess = cached;
      next();
      return;
    }

    try {
      const stored = await store.load(address);
      if (!stored) {
        res.status(403).json({ error: "no_delegation", message: "Delegation required" });
        return;
      }
      if (new Date(stored.expiresAt).getTime() <= Date.now()) {
        await store.remove(address);
        cache.evict(address);
        res.status(401).json({ error: "delegation_expired", message: "Delegation expired" });
        return;
      }
      if (!storedDelegationMatchesBackend(stored, backendDid)) {
        await store.remove(address);
        cache.evict(address);
        res.status(403).json({ error: "delegation_stale", message: "Delegation policy is stale" });
        return;
      }

      const delegation = deserializePortableDelegationSet(stored.serialized);
      const access = await activatePortableDelegation(node, delegation);
      cache.set(address, access);
      req.delegatedAccess = access;
      next();
    } catch (error) {
      console.error("[delegation] activation failed:", error);
      res
        .status(500)
        .json({ error: "delegation_activation_failed", message: "Failed to activate delegation" });
    }
  };
}

async function validateStoredDelegation(
  address: string,
  store: DelegationStore,
  cache: DelegationCache,
  backendDid: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string; message: string }> {
  const stored = await store.load(address);
  if (!stored) {
    cache.evict(address);
    return { ok: false, status: 403, error: "no_delegation", message: "Delegation required" };
  }
  if (new Date(stored.expiresAt).getTime() <= Date.now()) {
    await store.remove(address);
    cache.evict(address);
    return { ok: false, status: 401, error: "delegation_expired", message: "Delegation expired" };
  }
  if (!storedDelegationMatchesBackend(stored, backendDid)) {
    await store.remove(address);
    cache.evict(address);
    return {
      ok: false,
      status: 403,
      error: "delegation_stale",
      message: "Delegation policy is stale",
    };
  }
  return { ok: true };
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
