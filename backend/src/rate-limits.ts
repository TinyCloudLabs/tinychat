/**
 * Rate-limiter wiring (ST5).
 *
 * The verification proxies (signature / NRAS / Phala TDX / backend attestation) fan out to ~3-4
 * backend hits PER badge click and ~3 per model probe, so sharing the
 * 120-request global bucket with `/api/chat` lets a handful of verifications
 * 429 the next chat send (which `streamChat` treats as a fatal error). These
 * verification mounts get their OWN, far larger bucket and are exempted from the
 * global one so verification traffic can never exhaust the chat allowance.
 *
 * Extracted from index.ts so the wiring is unit-testable without booting the
 * full server.
 */
import rateLimit from "express-rate-limit";
import type { Express } from "express";

const WINDOW_MS = 15 * 60 * 1000;
export const GLOBAL_LIMIT = 120;
export const VERIFICATION_LIMIT = 600;
export const VERIFICATION_PATHS = [
  "/api/signature",
  "/api/nras-proxy",
  "/api/phala-verify",
  "/api/attestation/self",
] as const;

/**
 * Connector-webhook COMPANIONS (design §4.4). They mount after `applyRateLimiters`, so without
 * their own bucket they land in `globalLimiter`'s 120/15min — the bucket `/api/chat` shares,
 * and the exact failure this file's header describes for badge traffic. §3.7/§5.4 add three
 * calls per app visit (`GET …/webhooks/pending`, `POST …/webhooks/drain`, plus the delegation
 * probe below) and §3.3 fires them on EVERY mount, so on a shared-NAT office IP or a tab that
 * reloads often this would eat the chat allowance.
 */
export const CONNECTOR_COMPANION_LIMIT = 600;
export const CONNECTOR_COMPANION_PATHS = ["/api/connectors/webhooks"] as const;

/**
 * W5's authenticated READ API (backend-ingest plan §8.1 W5) gets its own bucket for exactly the
 * reason above: it is the cohort's meetings view, so ONE visit is a list plus a content GET per
 * meeting opened, and sharing `globalLimiter`'s 120/15min would let scrolling an archive 429 the
 * next chat send. Kept separate from the companions' bucket rather than folded into it — the two
 * surfaces have different callers (the drain card vs. the meetings view) and a busy archive must
 * not be able to exhaust the drain path either. Keyed by IP, like every other bucket here:
 * `applyRateLimiters` runs before `authMiddleware`.
 */
export const CONNECTOR_MEETINGS_LIMIT = 600;
export const CONNECTOR_MEETINGS_PATHS = ["/api/connectors/meetings"] as const;

/**
 * `/api/delegations` gets its OWN bucket, not a share of the companions' (§4.4 names the route;
 * S2e bounds one *request*, a bucket bounds a caller). Smaller than the companions': the visit
 * path costs one `GET /status` and, rarely, one mint, and a mint is the most expensive
 * authenticated request in the backend (sequential node round trips per resource). Keyed by IP,
 * because at `applyRateLimiters`' mount position `authMiddleware` has not run yet.
 */
export const DELEGATION_LIMIT = 240;
export const DELEGATION_PATHS = ["/api/delegations"] as const;

const DEDICATED_PATHS = [
  ...VERIFICATION_PATHS,
  ...CONNECTOR_COMPANION_PATHS,
  ...CONNECTOR_MEETINGS_PATHS,
  ...DELEGATION_PATHS,
] as const;

function matchesMountPath(path: string, mount: string): boolean {
  return path === mount || path.startsWith(`${mount}/`);
}

/** Mount the global limiter (exempting every path that carries its own bucket) plus one
 *  dedicated limiter per group: verification, connector companions, delegations. */
export function applyRateLimiters(app: Express): void {
  app.set("trust proxy", 1);
  const verificationLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: VERIFICATION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const connectorCompanionLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: CONNECTOR_COMPANION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const connectorMeetingsLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: CONNECTOR_MEETINGS_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const delegationLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: DELEGATION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const globalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: GLOBAL_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => DEDICATED_PATHS.some((p) => matchesMountPath(req.path, p)),
  });
  app.use(globalLimiter);
  for (const p of VERIFICATION_PATHS) app.use(p, verificationLimiter);
  for (const p of CONNECTOR_COMPANION_PATHS) app.use(p, connectorCompanionLimiter);
  for (const p of CONNECTOR_MEETINGS_PATHS) app.use(p, connectorMeetingsLimiter);
  for (const p of DELEGATION_PATHS) app.use(p, delegationLimiter);
}
