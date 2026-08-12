import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";

import type {
  ConnectorTeardown,
  ConnectorTeardownResult,
} from "../services/connector-teardown.js";
import {
  CredentialStore,
  type CredentialRevokeResult,
  type CredentialSecret,
} from "../services/credential-store.js";
import { createPkcePair } from "../services/fireflies-oauth.js";
import type { IngestModeLookup } from "../services/ingest-mode.js";
import {
  isValidSource,
  keyedLogHash,
  normalizeWebhookAddress,
} from "../services/webhook-tokens.js";
import { CONNECTOR_REGISTRY } from "./connector-webhooks.js";

/**
 * W2 — the authenticated custody surface (backend-ingest plan §6.2 "obtain" / "revoke").
 *
 * Mounted at `/api/connectors/credentials` behind the session `authMiddleware`, and ONLY when
 * `CONNECTOR_BACKEND_INGEST_ENABLED=true`. Two gates, not one:
 *
 *  1. The flag decides whether the mount exists at all (dark default — a non-cohort deployment
 *     has no credential surface to probe).
 *  2. The per-address cohort decides whether a signed-in user sees it. A non-cohort address gets
 *     **404**, identical to the flag being off: the reversal of "the backend never holds your
 *     Fireflies key" applies to enrolled addresses only, and nothing else may learn it exists.
 *
 * The tenant is ALWAYS the session address (`req.user.address`). No route accepts an address, an
 * account id or a token from the caller — §8.2 delta 1 / §9 anti-pattern 1 (Listen's global
 * "current user") is a class of bug that starts with a route taking a tenant as input.
 *
 * Nothing here ever returns, logs or echoes a credential. The retrieve path (`getCredential`) is
 * not reachable from this file at all: the disconnect route goes through `CredentialStore.revoke`,
 * which reads the secret internally to call the upstream revoke and never hands it back.
 */

export interface ConnectorOAuthPort {
  authorizeUrl(input: {
    state: string;
    challenge: string;
    source: string;
  }): string;
  exchangeCode(input: {
    code: string;
    verifier: string;
    source: string;
  }): Promise<CredentialSecret>;
  revoke(secret: CredentialSecret): Promise<void>;
}

export interface ConnectorCredentialRouterOptions {
  credentials: CredentialStore;
  oauth: ConnectorOAuthPort;
  /**
   * W7 (delta 12). When present, `DELETE /:source` is the FULL disconnect — purge tombstone,
   * credential, content rows and queue — rather than the credential row alone. Optional so a
   * harness can exercise the custody flows on their own; production always wires it, because a
   * disconnect that leaves the server's copy of the meetings behind is §9 anti-pattern 8.
   */
  teardown?: ConnectorTeardown;
  /** The cohort gate. Absent = no address is enrolled, so every route 404s. */
  modes?: IngestModeLookup;
  registry?: ReadonlySet<string>;
  now?: () => number;
  /** How long a started connect attempt may sit unfinished. */
  pendingTtlMs?: number;
  maxPending?: number;
}

/** A connect attempt in flight. The verifier lives here and NOWHERE a client can read it. */
interface PendingConnect {
  address: string;
  source: string;
  verifier: string;
  expiresAt: number;
}

export const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
export const DEFAULT_MAX_PENDING = 1_000;

function hashedAddress(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

function logCredentialRoute(fields: string): void {
  console.log(`[connector-credential] ${fields} t=${new Date().toISOString()}`);
}

export function createConnectorCredentialRouter(
  options: ConnectorCredentialRouterOptions,
): Router {
  const { credentials, oauth } = options;
  const registry = options.registry ?? CONNECTOR_REGISTRY;
  const now = options.now ?? (() => Date.now());
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const pending = new Map<string, PendingConnect>();
  const router = Router();

  /**
   * Session address + cohort + registry, in one place. Returns null having ALREADY answered, so
   * a handler that forgets a check cannot proceed without one.
   *
   * Fail closed: an unreadable cohort is a 503, never "treat them as not enrolled" (which for
   * this router would be indistinguishable from a working dark deployment and would hide the
   * outage) and never "treat them as enrolled".
   */
  async function tenant(req: Request, res: Response): Promise<string | null> {
    const source = req.params.source;
    if (!isValidSource(source) || !registry.has(source)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }

    let address: string;
    try {
      address = normalizeWebhookAddress(req.user?.address);
    } catch {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }

    if (options.modes === undefined) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    let mode: string;
    try {
      mode = await options.modes.mode(address);
    } catch {
      res.status(503).json({ error: "unavailable" });
      return null;
    }
    if (mode !== "backend") {
      // Dark for everyone else — the same answer as a deployment without the flag.
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return address;
  }

  function prunePending(): void {
    const cutoff = now();
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= cutoff) pending.delete(state);
    }
    while (pending.size >= maxPending) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
      // No silent caps.
      console.warn(
        `[connector-credential] op=connect-evict reason=cap cap=${maxPending} ` +
          `t=${new Date().toISOString()}`,
      );
    }
  }

  /**
   * §6.2 OBTAIN, step 1. Mints the PKCE pair and the state; returns the authorize URL only. The
   * verifier is the backend's half of the proof and never leaves this process.
   */
  router.post("/:source/oauth/start", async (req, res) => {
    const address = await tenant(req, res);
    if (address === null) return;
    const source = req.params.source;

    try {
      prunePending();
      const state = randomBytes(32).toString("base64url");
      const pkce = createPkcePair();
      pending.set(state, {
        address,
        source,
        verifier: pkce.verifier,
        expiresAt: now() + pendingTtlMs,
      });
      const authorizeUrl = oauth.authorizeUrl({
        state,
        challenge: pkce.challenge,
        source,
      });
      logCredentialRoute(
        `op=connect-start source=${source} aid=${hashedAddress(address)}`,
      );
      res.json({
        authorizeUrl,
        state,
        expiresAt: new Date(now() + pendingTtlMs).toISOString(),
      });
    } catch {
      res.status(500).json({ error: "internal_error" });
    }
  });

  /**
   * §6.2 OBTAIN, step 2. The credential goes STRAIGHT into the backend store — it is never
   * written to the user's browser vault for this purpose, and the shipped Option-C vault key is
   * never migrated into it. The response says "connected"; it never carries the credential.
   */
  router.post("/:source/oauth/callback", async (req, res) => {
    const address = await tenant(req, res);
    if (address === null) return;
    const source = req.params.source;

    const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
    if (typeof body.code !== "string" || body.code.length === 0) {
      res.status(400).json({ error: "invalid_code" });
      return;
    }
    if (typeof body.state !== "string" || body.state.length === 0) {
      res.status(400).json({ error: "invalid_state" });
      return;
    }

    const entry = pending.get(body.state);
    // The state must belong to THIS session address and THIS source, and must not have expired.
    // A state is single-use, deleted ONLY after the tenant/source/expiry checks pass — a delete
    // that runs on an unowned or replayed state hands anyone who guessed a leaked value (browser
    // history / referrer) the power to burn another user's in-flight state entry.
    if (
      entry === undefined ||
      entry.address !== address ||
      entry.source !== source ||
      entry.expiresAt <= now()
    ) {
      logCredentialRoute(
        `op=connect-callback result=invalid_state source=${source} aid=${hashedAddress(address)}`,
      );
      res.status(400).json({ error: "invalid_state" });
      return;
    }
    pending.delete(body.state);

    let secret: CredentialSecret;
    try {
      secret = await oauth.exchangeCode({
        code: body.code,
        verifier: entry.verifier,
        source,
      });
    } catch {
      // The provider's message is discarded: an authorization-code error can quote the code.
      logCredentialRoute(
        `op=connect-callback result=exchange_failed source=${source} aid=${hashedAddress(address)}`,
      );
      res.status(502).json({ error: "upstream_exchange_failed" });
      return;
    }

    try {
      const meta = await credentials.store({ source, address, secret });
      res.json({
        connected: true,
        source: meta.source,
        kind: meta.kind,
        createdAt: meta.createdAt,
      });
    } catch {
      // A store that did not acknowledge is a store that did not happen (fail closed).
      logCredentialRoute(
        `op=connect-callback result=store_failed source=${source} aid=${hashedAddress(address)}`,
      );
      res.status(503).json({ error: "store_unavailable" });
    }
  });

  /** Existence + audit stamps for the settings card. Never the credential, never the envelope. */
  router.get("/:source", async (req, res) => {
    const address = await tenant(req, res);
    if (address === null) return;

    try {
      const meta = await credentials.status(req.params.source, address);
      if (meta === null) {
        res.json({ connected: false, source: req.params.source });
        return;
      }
      res.json({
        connected: meta.revokedAt === undefined,
        source: meta.source,
        kind: meta.kind,
        createdAt: meta.createdAt,
        rotatedAt: meta.rotatedAt,
        lastUsedAt: meta.lastUsedAt,
      });
    } catch {
      res.status(503).json({ error: "unavailable" });
    }
  });

  /**
   * §6.2 REVOKE — and, with W7's `teardown` wired, the whole disconnect (plan §8.1 W7): purge
   * tombstone, credential row + upstream revoke, every content row, the queue. ONE idempotent
   * call, for the same reason the Option-C teardown is one: a second call the client never makes
   * leaves a half-disconnected connector.
   *
   * An upstream revoke failure is SURFACED — 502 with `deleted: true` — because custody has
   * still ended locally and the operator (and the user) must know the provider-side grant may
   * still be live. The local counts ride along on that arm too: the rest of the teardown ran.
   */
  router.delete("/:source", async (req, res) => {
    const address = await tenant(req, res);
    if (address === null) return;

    let result: CredentialRevokeResult;
    // The teardown's counts, or nothing when only the credential row was revoked. Kept beside
    // the Result rather than sniffed off it: a response field that exists only sometimes should
    // be visibly optional at the point it is produced.
    let counts: { contentRemoved: number; queueDropped: number } | null = null;
    try {
      if (options.teardown !== undefined) {
        const torn: ConnectorTeardownResult = await options.teardown.run(
          req.params.source,
          address,
        );
        result = torn;
        counts = {
          contentRemoved: torn.contentRemoved,
          queueDropped: torn.queueDropped,
        };
      } else {
        result = await credentials.revoke(req.params.source, address);
      }
    } catch {
      // The tombstone is written first, so a failure below it has already classified this
      // tenant's content as purged. 503 asks for a retry of the SAME idempotent call.
      logCredentialRoute(
        `op=disconnect result=teardown_incomplete source=${req.params.source} ` +
          `aid=${hashedAddress(address)}`,
      );
      res.status(503).json({ error: "revoke_failed" });
      return;
    }

    if (result.upstreamRevoked === "failed") {
      res.status(502).json({
        error: "upstream_revoke_failed",
        deleted: result.deleted,
        upstreamRevoked: false,
        ...(counts ?? {}),
      });
      return;
    }
    res.json({
      deleted: result.deleted,
      upstreamRevoked: result.upstreamRevoked === "ok",
      ...(counts ?? {}),
    });
  });

  return router;
}
