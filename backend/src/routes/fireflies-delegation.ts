import express, { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import {
  evictDelegateNodeGrants,
  type FirefliesDelegateIdentity,
} from "../fireflies-import-identity.js";
import {
  verifyFirefliesImportGrants,
  type VerifiedFirefliesImportGrants,
} from "../fireflies-import-verify.js";
import { DelegationActivationError } from "../portable-delegation.js";
import { TenantCoordinator } from "../services/calendar-autojoin-store.js";
import { FirefliesGrantReplacesMismatchError, type FirefliesGrantStore } from "../services/fireflies-grant-store.js";
import {
  MAX_SERIALIZED_DELEGATION_BYTES,
  MAX_SIGNATURE_BYTES,
  MAX_SIWE_BYTES,
  requireUser,
} from "./delegations.js";

const MAX_ACCEPTS_PER_HOUR = 6;
const ACCEPT_WINDOW_MS = 3_600_000;

export interface FirefliesDelegationRoutesConfig {
  delegate: FirefliesDelegateIdentity;
  configuredHost: string;
  store: Pick<FirefliesGrantStore, "store" | "ownerStatus" | "status" | "remove" | "grantCids">;
  authMiddleware: RequestHandler;
  coordinator?: TenantCoordinator;
  now?: () => number;
  /** Optional override for dry-activating verified grants; defaults to `delegate.node.useDelegation`. */
  activate?: (verified: VerifiedFirefliesImportGrants) => Promise<void>;
}

async function defaultActivateFirefliesGrants(
  delegate: FirefliesDelegateIdentity,
  verified: VerifiedFirefliesImportGrants,
  configuredHost: string,
): Promise<void> {
  // Dry-activate on an isolated scoped node and evict immediately in finally so the shared
  // delegate identity retains zero cross-tenant state.
  const scopedNode = delegate.createScopedNode();
  try {
    const activateOne = async (grant: VerifiedFirefliesImportGrants["secrets"]) => {
      const primary = grant.resources[0]!;
      await scopedNode.useDelegation({
        cid: grant.cid,
        delegationHeader: { Authorization: grant.authorization },
        spaceId: grant.spaceId,
        path: primary.path,
        actions: [...primary.actions],
        resources: grant.resources.map((resource) => ({
          service: resource.service,
          space: resource.space,
          path: resource.path,
          actions: [...resource.actions],
        })),
        expiry: grant.expiresAt,
        delegateDID: verified.delegateDid,
        ownerAddress: verified.ownerAddress,
        chainId: verified.chainId,
        host: configuredHost,
      });
    };
    await activateOne(verified.secrets);
    await activateOne(verified.meetings);
  } finally {
    evictDelegateNodeGrants(scopedNode);
  }
}

/**
 * Authenticated routes for Fireflies server-import grants:
 *   GET    /api/connectors/fireflies/delegation — content-free status `{ state, expiresAt }`
 *   POST   /api/connectors/fireflies/delegation — verify, dry-activate and seal encrypted grant pair
 *   DELETE /api/connectors/fireflies/delegation — delete stored grant
 *
 * Mounted ONLY when `FIREFLIES_SERVER_IMPORT_ENABLED === "true"`. Behind Bearer auth and global CSRF
 * (`X-Requested-With`). Logs carry operational status codes only — never addresses, tokens or keys.
 */
export function createFirefliesDelegationRouter(config: FirefliesDelegationRoutesConfig): Router {
  const router = Router();
  const coordinator = config.coordinator ?? new TenantCoordinator();
  const accepts = new Map<string, number[]>();
  const nowFn = config.now ?? Date.now;

  function pruneAccepts(now: number): void {
    for (const [key, timestamps] of accepts) {
      const live = timestamps.filter((time) => now - time < ACCEPT_WINDOW_MS);
      if (live.length === 0) accepts.delete(key);
      else if (live.length !== timestamps.length) accepts.set(key, live);
    }
  }
  const deps = {
    computeDelegationCid: config.delegate.node.computeDelegationCid.bind(config.delegate.node),
  };
  const activate =
    config.activate ??
    ((verified: VerifiedFirefliesImportGrants) =>
      defaultActivateFirefliesGrants(config.delegate, verified, config.configuredHost));

  router.use(config.authMiddleware);

  router.get("/", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const address = user.address.toLowerCase();
    try {
      const status = await coordinator.run(address, () =>
        config.store.status(address, {
          configuredHost: config.configuredHost,
          deps,
          now: nowFn(),
        }),
      );
      res.json({ state: status.state, expiresAt: status.expiresAt });
    } catch {
      console.warn("[fireflies-delegation] op=status result=unavailable");
      res.status(503).json({ error: "unavailable" });
    }
  });

  // The two grant ids, for the owner's browser to revoke at the node when it turns the import off or purges.
  // Ids only, kept from the moment the pair is accepted until it is removed, so a lapsed pair still lists them.
  router.get("/grants", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const address = user.address.toLowerCase();
    try {
      const cids = await coordinator.run(address, () => config.store.grantCids(address));
      res.json({ grantCids: cids ? [cids.secrets, cids.meetings] : [] });
    } catch {
      console.warn("[fireflies-delegation] op=grants result=unavailable");
      res.status(503).json({ error: "unavailable" });
    }
  });

  // Everything the owner's browser needs to turn the import on, renew it or take it off: whom to delegate to,
  // the state and end date, and the two ids to replace. Public values only; never any grant material.
  router.get("/status", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const address = user.address.toLowerCase();
    try {
      const options = { configuredHost: config.configuredHost, deps, now: nowFn() };
      // One read for the state and the ids: two reads could straddle a removal and show an active pair with no ids.
      const owned = await coordinator.run(address, () => config.store.ownerStatus(address, options));
      res.json({
        state: owned.state,
        expiresAt: owned.expiresAt,
        delegateDid: config.delegate.did,
        grantCids: owned.grantCids,
      });
    } catch {
      console.warn("[fireflies-delegation] op=owner-status result=unavailable");
      res.status(503).json({ error: "unavailable" });
    }
  });

  // Per-address quota precedes the first read of the POST body.
  router.post(
    "/",
    (req, res, next) => {
      const user = requireUser(req, res);
      if (!user) return;
      const address = user.address.toLowerCase();
      const now = nowFn();
      pruneAccepts(now);
      const recent = accepts.get(address) ?? [];
      if (recent.length >= MAX_ACCEPTS_PER_HOUR) {
        res.status(429).json({ error: "delegation_rate_limited" });
        return;
      }
      recent.push(now);
      accepts.set(address, recent);
      next();
    },
    express.json({ limit: "160kb" }),
    async (req: Request, res: Response) => {
      const address = req.user!.address.toLowerCase();
      const body: unknown = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      const { secretsGrant, meetingsGrant, siwe, signature, replaces: replacesRaw } = body as Record<string, unknown>;
      // The ids of the grants this one replaces: required, and empty when the owner has nothing stored.
      if (
        !Array.isArray(replacesRaw) ||
        replacesRaw.length > 2 ||
        !replacesRaw.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
      ) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      const replaces: string[] = replacesRaw;
      if (
        typeof secretsGrant !== "string" ||
        !secretsGrant ||
        typeof meetingsGrant !== "string" ||
        !meetingsGrant ||
        typeof siwe !== "string" ||
        !siwe ||
        typeof signature !== "string" ||
        !signature
      ) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      if (
        Buffer.byteLength(secretsGrant) > MAX_SERIALIZED_DELEGATION_BYTES ||
        Buffer.byteLength(meetingsGrant) > MAX_SERIALIZED_DELEGATION_BYTES ||
        Buffer.byteLength(siwe) > MAX_SIWE_BYTES ||
        Buffer.byteLength(signature) > MAX_SIGNATURE_BYTES
      ) {
        res.status(400).json({ error: "bundle_too_large" });
        return;
      }

      let incoming;
      try {
        incoming = await verifyFirefliesImportGrants(
          {
            secretsGrant,
            meetingsGrant,
            siwe,
            signature,
            address,
            delegateDid: config.delegate.did,
            configuredHost: config.configuredHost,
            now: nowFn(),
          },
          deps,
        );
      } catch {
        res.status(400).json({ error: "invalid_delegation" });
        return;
      }
      if (!incoming.ok) {
        console.warn(`[fireflies-delegation] op=accept result=rejected code=${incoming.code}`);
        res.status(400).json({ error: incoming.code });
        return;
      }

      try {
        const expiresAt = await coordinator.run(address, async () => {
          await activate(incoming.verified);
          await config.store.store(
            address,
            { secretsGrant, meetingsGrant, siwe, signature },
            incoming.verified.expiresAt,
            replaces,
          );
          return incoming.verified.expiresAt.toISOString();
        });
        console.log("[fireflies-delegation] op=accept result=stored");
        res.json({ state: "active", expiresAt });
      } catch (error) {
        if (error instanceof FirefliesGrantReplacesMismatchError) {
          console.warn("[fireflies-delegation] op=accept result=replaces_mismatch");
          res.status(409).json({ error: "replaces_mismatch" });
          return;
        }
        if (error instanceof DelegationActivationError && (error.status === 401 || error.status === 403)) {
          console.warn("[fireflies-delegation] op=accept result=node_rejected");
          res.status(403).json({ error: "delegation_rejected" });
          return;
        }
        console.warn("[fireflies-delegation] op=accept result=unavailable");
        res.status(503).json({ error: "unavailable" });
      }
    },
  );

  router.use((error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
    if (
      error instanceof SyntaxError ||
      (typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed")
    ) {
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
        await config.store.remove(address);
      });
      console.log("[fireflies-delegation] op=delete result=removed");
      res.json({ state: "none", expiresAt: null });
    } catch {
      console.warn("[fireflies-delegation] op=delete result=unavailable");
      res.status(503).json({ error: "unavailable" });
    }
  });

  return router;
}
