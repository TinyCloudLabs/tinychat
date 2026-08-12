import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { DelegationCache, DelegationStore } from "@tinyboilerplate/server";
import { backendDelegationPolicyHash, backendDelegationResolvedPermissions } from "../manifest.js";
import {
  activatePortableDelegation,
  deserializePortableDelegationSet,
  normalizeDid,
} from "../portable-delegation.js";
import { redactedErrorMessage } from "../services/webhook-tokens.js";

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
      // Re-activation is clamped to the policy too (§3.2a edit 2) — the stored bundle is not
      // re-trusted just because it was accepted once.
      const access = await activatePortableDelegation(node, delegation, {
        policy: backendDelegationResolvedPermissions(backendDid),
        // §3.2a — re-run against the STORED bundle, not inherited from the accept route.
        ownerAddress: address,
      });
      cache.set(address, access);
      req.delegatedAccess = access;
      next();
    } catch (error) {
      // §6.3, same reason as the accept route: the stored `serialized` is capability material and
      // a parse/activation failure prints a fragment of it onto a `public_logs=true` stream.
      console.error("[delegation] activation failed:", redactedErrorMessage(error));
      res
        .status(500)
        .json({ error: "delegation_activation_failed", message: "Failed to activate delegation" });
    }
  };
}

/**
 * §3.6 rule 1, for callers that are not a request: re-validate the STORED record — existence,
 * `expiresAt`, `policyHash`/`delegateDid` — rather than trusting a warm cache entry. A cache hit
 * is not evidence the grant still exists, and the drain (W5) holds an activated access in
 * memory for up to the cache TTL.
 *
 * Shares `validateStoredDelegation` with the middleware on purpose: a second copy of this check
 * is a second thing to forget to update when the policy changes.
 */
export function createStoredDelegationGate(config: {
  store: DelegationStore;
  cache: DelegationCache;
  backendDid: string;
}): { validate(address: string): Promise<{ ok: true } | { ok: false; reason: string }> } {
  return {
    validate: async (address: string) => {
      const result = await validateStoredDelegation(
        address,
        config.store,
        config.cache,
        config.backendDid,
      );
      return result.ok ? { ok: true } : { ok: false, reason: result.error };
    },
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
