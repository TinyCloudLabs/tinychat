/**
 * Rate-limiter wiring (ST5).
 *
 * The verification proxies (signature / NRAS / Phala TDX) fan out to ~3-4
 * backend hits PER badge click and ~3 per model probe, so sharing the
 * 120-request global bucket with `/api/chat` lets a handful of verifications
 * 429 the next chat send (which `streamChat` treats as a fatal error). These
 * three mounts get their OWN, far larger bucket and are exempted from the
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
] as const;

/** Mount the global limiter (exempting the verification paths) and the larger
 *  verification-only limiter on those three paths. */
export function applyRateLimiters(app: Express): void {
  const verificationLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: VERIFICATION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const globalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: GLOBAL_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => VERIFICATION_PATHS.some((p) => req.path.startsWith(p)),
  });
  app.use(globalLimiter);
  for (const p of VERIFICATION_PATHS) app.use(p, verificationLimiter);
}
