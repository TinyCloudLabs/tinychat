import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import type { ServerInfoPermission } from "@tinyboilerplate/core";
import type {
  DelegatedAccess,
  DelegationCache,
  DelegationStore,
} from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  BACKEND_DELEGATION_EXPIRY_MS,
  backendDelegationPolicyHash,
  backendDelegationResolvedPermissions,
  delegationCoversBackendPolicy,
  delegationExceedsBackendPolicy,
} from "../manifest.js";
import {
  activatePortableDelegation,
  deserializePortableDelegationSet,
  extractPortableDelegationIdentity,
  extractPortableResources,
  foreignSpaceIdDelegations,
  foreignSpaceResources,
  MAX_ACTIVATABLE_RESOURCES,
  normalizeAddress,
  normalizeDid,
  portableDelegationExpiry,
  portableDelegations,
  type PortableDelegationSet,
} from "../portable-delegation.js";
import { redactedErrorMessage } from "../services/webhook-tokens.js";

/**
 * §3.5 (S2e) — the accept route capped NOTHING about the bundle, and B1's `Promise.all` →
 * sequential fix turns that into a DoS multiplier: every extracted resource becomes one
 * serialized `node.useDelegation` round trip inside one HTTP request, against the ~0.5 writes/sec
 * node §9.3 budgets across all users and apps, and any address that can complete SIWE (free,
 * unlimited) can hold that budget. The only prior bounds were the 1 MB global JSON parser and a
 * 240-req/15-min bucket. A legitimate 2-path bundle is a few kB.
 *
 * Rejected, never truncated (the no-silent-caps rule this feature uses everywhere else).
 */
export const MAX_SERIALIZED_DELEGATION_BYTES = 64 * 1024;
/** Enough for Option A's widest shape: sql + connectors-kv + two secrets entries. */
export const MAX_BUNDLE_DELEGATIONS = 4;

/**
 * OPTION C — this route carries NO connector hooks, by decision.
 *
 * It once took two: `isBackgroundSyncDisabled` (refuse to mint while the Fireflies webhook
 * disabled marker stood — 409, or a fail-closed 503 when the marker was unreadable) and
 * `onDelegationAccepted` (kick the connector drain after a fresh grant). Both protected a
 * *connector* delegation the server does not hold and will not mint: under Option C it receives
 * signed webhook notifications, queues meeting ids, never sees the Fireflies API key and never
 * writes meeting content to the user's space — the browser does that on the next usable visit.
 *
 * What remained was a coupling pointed the wrong way. This is the GENERIC delegation behind
 * every authenticated TinyChat write, so an optional notification toggle (or an unrelated KV
 * hiccup in the webhook namespace) could refuse chat access outright. Do not re-add either hook;
 * `connector-delegation-independence.test.ts` drives both routers against one store to pin it.
 */
interface DelegationRoutesConfig {
  backendDid: string;
  store: Pick<DelegationStore, "store" | "load" | "remove">;
  cache: Pick<DelegationCache, "get" | "set" | "evict">;
  authMiddleware: RequestHandler;
  node?: TinyCloudNode;
  deserializeDelegationSet?: (serialized: string) => PortableDelegationSet;
  activateDelegation?: (
    delegation: PortableDelegationSet,
  ) => Promise<DelegatedAccess>;
  extractResources?: (
    delegation: PortableDelegationSet,
  ) => ServerInfoPermission[];
  extractExpiry?: (delegation: PortableDelegationSet) => Date | null;
}

export function createDelegationRouter(config: DelegationRoutesConfig) {
  const router = Router();
  router.use(config.authMiddleware);

  router.get("/status", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    let stored;
    try {
      stored = await config.store.load(user.address);
    } catch {
      console.warn("[delegations] op=status-load result=error");
      res.status(503).json({ error: "unavailable" });
      return;
    }
    if (!stored) {
      res.json({ status: "none", expiresAt: null });
      return;
    }

    if (new Date(stored.expiresAt).getTime() <= Date.now()) {
      try {
        await config.store.remove(user.address);
      } catch {
        console.warn("[delegations] op=status-cleanup result=error");
        res.status(503).json({ error: "unavailable" });
        return;
      }
      config.cache.evict(user.address);
      res.json({ status: "expired", expiresAt: stored.expiresAt });
      return;
    }

    if (!storedDelegationMatchesBackend(stored, config.backendDid)) {
      try {
        await config.store.remove(user.address);
      } catch {
        console.warn("[delegations] op=status-cleanup result=error");
        res.status(503).json({ error: "unavailable" });
        return;
      }
      config.cache.evict(user.address);
      res.json({ status: "stale", expiresAt: null });
      return;
    }

    // `verified: false` is not decoration and it is not a placeholder. §9.2's chokepoint does not
    // exist yet (S1's V-vs-F verdict is unproduced — `docs/connector-webhooks-delegation-gate.md`),
    // so every field this record was built from — resources, delegator, expiry — came from the
    // bundle's UNSIGNED top level. `active` therefore means "stored, unexpired and addressed to
    // this backend", never "checked", and a status that cannot be falsified must at least say so.
    // Additive rather than a new enum member: `status` keeps its contract for existing clients,
    // and the limitation becomes machine-readable today instead of after the enum change lands.
    res.json({
      status: "active",
      expiresAt: stored.expiresAt,
      verified: false,
    });
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

    // S2e, BEFORE any deserialization: the string itself is stored verbatim on the shared
    // single-writer node, so the cap has to bite ahead of `JSON.parse`, not after it.
    if (serialized.length > MAX_SERIALIZED_DELEGATION_BYTES) {
      console.warn(
        `[delegations] rejecting oversize bundle: ${serialized.length} > ${MAX_SERIALIZED_DELEGATION_BYTES}`,
      );
      res.status(400).json({
        error: "bundle_too_large",
        message: "Delegation bundle exceeds the maximum accepted size",
        maxBytes: MAX_SERIALIZED_DELEGATION_BYTES,
      });
      return;
    }

    try {
      const deserialize =
        config.deserializeDelegationSet ?? deserializePortableDelegationSet;
      const delegation = deserialize(serialized);

      // S2e: `deserializePortableDelegationSet` maps EVERY element of `bundle.delegations` with no
      // length check, and each one contributes activations below.
      const bundleSize = portableDelegations(delegation).length;
      if (bundleSize > MAX_BUNDLE_DELEGATIONS) {
        console.warn(
          `[delegations] rejecting bundle carrying ${bundleSize} delegations (max ${MAX_BUNDLE_DELEGATIONS})`,
        );
        res.status(400).json({
          error: "bundle_too_many_delegations",
          message:
            "Delegation bundle carries more delegations than the backend accepts",
          max: MAX_BUNDLE_DELEGATIONS,
        });
        return;
      }

      const identity = extractPortableDelegationIdentity(delegation);
      if (!identity) {
        res.status(400).json({
          error: "invalid_delegation_identity",
          message:
            "Delegation does not expose a consistent owner and delegatee",
        });
        return;
      }

      if (
        normalizeAddress(identity.ownerAddress) !==
        normalizeAddress(user.address)
      ) {
        res.status(400).json({
          error: "wrong_delegator",
          message: "Delegation owner does not match the authenticated user",
          expected: user.address,
          actual: identity.ownerAddress,
        });
        return;
      }

      if (
        normalizeDid(identity.delegateDID) !== normalizeDid(config.backendDid)
      ) {
        res.status(400).json({
          error: "wrong_delegatee",
          message:
            "Delegation delegatee does not match the current backend DID",
          expected: config.backendDid,
          actual: identity.delegateDID,
        });
        return;
      }

      // §9.2 (task S2) IS NOT BUILT: `extractPortableResources` projects the UNSIGNED top-level
      // `resources` array, not the verified `att`. So every authorization input below —
      // identity, coverage, the least-privilege ceiling and `expiresAt` — reads attacker-authored
      // JSON, and the SDK verifies nothing on the accept path either (`deserializeDelegation` is
      // `JSON.parse`; `useDelegation` is local-only). The ceiling therefore bounds only what the
      // bundle DECLARES; the sole real bound is the activation clamp below, and that is an
      // in-process bound on what THIS process invokes, not on what is stored. S1's V-or-F verdict
      // and V1's captured `att` gate the fix — see docs/connector-webhooks-delegation-gate.md.
      const resources = (config.extractResources ?? extractPortableResources)(
        delegation,
      );

      // S2e's third cap. The clamp dedupes for ACTIVATION, so N identical policy-shaped entries
      // collapse to one activation and never reach `assertSupportedMultiResourceShape` — but all N
      // are still persisted verbatim by `store()` on the shared single-writer node.
      if (resources.length > MAX_ACTIVATABLE_RESOURCES) {
        console.warn(
          `[delegations] rejecting bundle declaring ${resources.length} resources (max ${MAX_ACTIVATABLE_RESOURCES})`,
        );
        res.status(400).json({
          error: "bundle_too_many_resources",
          message:
            "Delegation bundle declares more resources than the backend accepts",
          max: MAX_ACTIVATABLE_RESOURCES,
        });
        return;
      }

      if (!delegationCoversBackendPolicy(resources, config.backendDid)) {
        res.status(400).json({
          error: "insufficient_delegation",
          message: "Delegation does not cover the current backend policy",
          required: backendDelegationResolvedPermissions(config.backendDid),
        });
        return;
      }

      // Least-privilege ceiling (§3.2a edit 1): the coverage check above only asks whether the
      // bundle covers the policy, so a strictly broader grant passes it. Reject before anything
      // is activated or stored — an in-process bound on what may be stored, not a node-enforced
      // restriction on what the delegatee can invoke.
      //
      // `delegationExceedsBackendPolicy` compares spaces the way `isCapabilitySubset` does — by
      // the segment after the LAST colon — so `tinycloud:0xVICTIM:applications` reads as the
      // policy's own `applications` and the offending list comes back EMPTY. Only the activation
      // clamp refuses that, and it runs after the bundle has been declared storable. Same identity
      // rule, applied here, so the ceiling and the clamp agree (as `isCanonicalResourcePath`
      // already does across both).
      const overbroad = [
        ...foreignSpaceResources(delegation),
        ...delegationExceedsBackendPolicy(resources, config.backendDid),
      ];
      if (overbroad.length > 0) {
        console.warn(
          `[delegations] rejecting delegation broader than the backend policy: ${describeResources(overbroad)}`,
        );
        res.status(400).json({
          error: "overbroad_delegation",
          message: "Delegation grants more than the current backend policy",
          offending: overbroad,
          allowed: backendDelegationResolvedPermissions(config.backendDid),
        });
        return;
      }

      // §3.2a, top-level `spaceId` half. Checked AFTER the resource-level ceiling so a bundle
      // that is overbroad in both respects still reports the more specific `overbroad_delegation`,
      // and BEFORE activation so nothing is invoked or stored. `foreignSpaceResources` above
      // compares the resource space against this same unsigned field, so setting the two EQUAL to
      // a victim's space is invisible to it — and a resource that declares no space at all never
      // reaches the identity rule in the clamp. Both variants activated against the victim's
      // space before this check existed. See `foreignSpaceIdDelegations` for what this is not.
      const foreignSpaceIds = foreignSpaceIdDelegations(
        delegation,
        user.address,
      );
      if (foreignSpaceIds.length > 0) {
        console.warn(
          `[delegations] rejecting bundle whose space id is not the authenticated user's: ` +
            `count=${foreignSpaceIds.length} ${foreignSpaceIds.map(safeLogField).join(", ")}`,
        );
        res.status(400).json({
          error: "foreign_space_delegation",
          message:
            "Delegation targets a space that does not belong to the authenticated user",
        });
        return;
      }

      const activate =
        config.activateDelegation ??
        ((input: PortableDelegationSet) => {
          if (!config.node)
            throw new Error(
              "TinyCloud node is required to activate delegations",
            );
          return activatePortableDelegation(config.node, input, {
            policy: backendDelegationResolvedPermissions(config.backendDid),
            ownerAddress: user.address,
          });
        });
      const access = await activate(delegation);
      // §3.3 / §9.2 task S2c, interim half. The full fix derives `expiresAt` from the VERIFIED
      // JWT `exp`; until the `att` is verified the source of this number is an unsigned,
      // rewritable top-level field, so at minimum the number the UI reports and the drain gate
      // trusts is bounded here. `DEFAULT_DELEGATION_EXPIRY_MS` is one YEAR and must never be the
      // fallback on this path: a bundle with no `expiry` would otherwise be reported `active`
      // for a year, the renew-at-T-48h would never fire, and the user would only reach §3.7's
      // Reconnect state after writes started failing.
      const ceiling = new Date(Date.now() + BACKEND_DELEGATION_EXPIRY_MS);
      const claimed = (config.extractExpiry ?? portableDelegationExpiry)(
        delegation,
      );
      const expiry =
        claimed !== null && claimed.getTime() < ceiling.getTime()
          ? claimed
          : ceiling;
      const expiresAt = expiry.toISOString();

      try {
        await config.store.store(user.address, serialized, {
          expiresAt,
          actions: [],
          path: "",
          policyHash: backendDelegationPolicyHash(config.backendDid),
          delegateDid: config.backendDid,
          resources,
        });
      } catch {
        console.error("[delegations] op=store result=error");
        res.status(503).json({ error: "unavailable" });
        return;
      }
      config.cache.set(user.address, access);
      // Same contract as GET /status: accepted and stored, not verified (§9.2 / S1).
      res.json({ status: "active", expiresAt, verified: false });
    } catch (error) {
      // §6.3 — `public_logs=true`. The raw error object echoed the submitted string back onto a
      // world-readable stream: a non-JSON `serialized` produced `SyntaxError: JSON Parse error:
      // Unexpected identifier "…"` carrying ~50 verbatim characters of capability material (the
      // bundle carries `delegationHeader`), and an Error prints its own enumerable properties —
      // body-parser puts the request body on one. Message only, redacted, bounded.
      console.error(
        "[delegations] failed to accept delegation:",
        redactedErrorMessage(error),
      );
      res.status(400).json({
        error: "invalid_delegation",
        message: "Failed to process delegation",
      });
    }
  });

  router.delete("/", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      await config.store.remove(user.address);
    } catch {
      console.warn("[delegations] op=delete result=error");
      res.status(503).json({ error: "unavailable" });
      return;
    }
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

/**
 * §6.3 / T13, applied to the DELEGATION path. The deploy runs `phala deploy --public-logs`, so
 * this stream is world-readable and §6.3 rests on it being forensically trustworthy — and
 * `describeResources` interpolated `resource.service`/`path`/`actions` straight into a
 * `console.warn` with no sanitization and no length bound. A resource path of
 * `xyz.tinycloud.tinychat/evil/\n[connector-webhook] op=disable aid=… FORGED-LINE` produced a
 * complete, plausible connector-webhook line on the stream from an ordinary authenticated
 * session; at 8 resources x multi-kB paths inside the 64 kB bundle cap it is also a log-volume
 * amplifier. `sanitizeErrorCode` exists for exactly this hazard and the drain applies it — these
 * call sites did not.
 *
 * Allowlist, then bound: characters outside `[A-Za-z0-9._/:-]` are dropped (so `\n`, `\r` and
 * every terminal escape are gone by construction, not by escaping), each field is capped, and
 * the joined string is capped again.
 */
const LOGGABLE_FIELD = /[^A-Za-z0-9._/:-]/g;
const MAX_LOGGED_FIELD_LENGTH = 120;
const MAX_LOGGED_RESOURCES = 8;

function safeLogField(value: unknown): string {
  if (typeof value !== "string") return "invalid";
  const cleaned = value.replace(LOGGABLE_FIELD, "");
  if (cleaned === "") return "empty";
  return cleaned.length > MAX_LOGGED_FIELD_LENGTH
    ? `${cleaned.slice(0, MAX_LOGGED_FIELD_LENGTH)}-truncated`
    : cleaned;
}

function describeResources(resources: readonly ServerInfoPermission[]): string {
  const shown = resources.slice(0, MAX_LOGGED_RESOURCES);
  const described = shown
    .map(
      (resource) =>
        `${safeLogField(resource.service)}:${safeLogField(resource.path)} ` +
        `[${(Array.isArray(resource.actions) ? resource.actions : []).map(safeLogField).join("|")}]`,
    )
    .join(", ");
  // The COUNT is the field an operator actually needs; the text is a convenience and is bounded.
  const omitted = resources.length - shown.length;
  return `count=${resources.length}${omitted > 0 ? ` shown=${shown.length}` : ""} ${described}`;
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
