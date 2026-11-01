/**
 * TC-1964: an optional, authenticated, read-only HTTP read of the stored connector credential row
 * count (`GET /api/internal/credential-row-count?source=fireflies`), for an operator who cannot
 * read backend logs. It exists only until the backend ingestion removal ships.
 *
 * Off unless `CREDENTIAL_COUNT_ADMIN_KEY` is set to at least 32 characters (after trim): otherwise
 * the route is not registered at all (404), and a too-short key logs ONE fixed line without the
 * value. The request must carry the key in `x-admin-key`; a missing or wrong key is a bare 401
 * with no body. The compare is constant-time over sha256 digests, so a length mismatch is safe.
 * The key is compared FIRST, then one of two hard hourly buckets (rate-limits.ts) is charged: a
 * failure bucket (5/h) for wrong or missing keys, a success bucket (10/h) for the correct key.
 * Exhausted buckets answer a bare 429. A wrong key can never spend the correct key's bucket, so
 * guessing cannot lock the operator out. Every response carries `Cache-Control: no-store`.
 *
 * The count itself is `countCredentialRows` (credential-row-count.ts): only a number or a fixed
 * code is ever returned — never a key, address, cursor, row value or error message — and nothing
 * is logged per request, nor is the key or header ever logged or echoed.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Express } from "express";
import {
  CREDENTIAL_COUNT_PATHS,
  createCredentialCountLimiters,
  type CredentialCountLimiters,
} from "../rate-limits.js";
import {
  countCredentialRows,
  type CredentialRowCounter,
} from "../services/credential-row-count.js";

export const CREDENTIAL_COUNT_ADMIN_KEY_ENV = "CREDENTIAL_COUNT_ADMIN_KEY";
export const CREDENTIAL_COUNT_ADMIN_KEY_MIN_LENGTH = 32;
export const CREDENTIAL_COUNT_ADMIN_KEY_HEADER = "x-admin-key";
export const CREDENTIAL_COUNT_ROUTE_PATH = CREDENTIAL_COUNT_PATHS[0];
export const CREDENTIAL_COUNT_SHORT_KEY_LOG =
  "credential_count_route disabled: CREDENTIAL_COUNT_ADMIN_KEY is shorter than the minimum length";

export type CredentialCountAdminKey =
  | { state: "off" }
  | { state: "short" }
  | { state: "on"; key: string };

export function resolveCredentialCountAdminKey(
  env: Record<string, string | undefined>,
): CredentialCountAdminKey {
  const key = env[CREDENTIAL_COUNT_ADMIN_KEY_ENV]?.trim() ?? "";
  if (key.length === 0) return { state: "off" };
  if (key.length < CREDENTIAL_COUNT_ADMIN_KEY_MIN_LENGTH) return { state: "short" };
  return { state: "on", key };
}

/** Constant-time compare of fixed-size digests: equal-length inputs to `timingSafeEqual` whatever was presented. */
export function adminKeyMatches(presented: string | undefined, expected: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export function createCredentialCountRouter(
  adminKey: string,
  makeStore: () => CredentialRowCounter,
  limiters: CredentialCountLimiters = createCredentialCountLimiters(),
): Router {
  const router = Router();
  let store: CredentialRowCounter | null = null;
  const getStore = (): CredentialRowCounter => (store ??= makeStore());

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/", async (req, res) => {
    // The key is compared FIRST and each outcome charges its own bucket: a wrong key can only
    // spend the failure bucket, so guessing cannot lock out the holder of the correct key.
    if (!adminKeyMatches(req.get(CREDENTIAL_COUNT_ADMIN_KEY_HEADER), adminKey)) {
      if (await limiters.failure(req, res)) res.status(401).end();
      return;
    }
    if (!(await limiters.success(req, res))) return;
    res.status(200).json(await countCredentialRows(getStore, req.query.source));
  });
  return router;
}

/**
 * Registers the route only when a valid key is configured; returns whether it did. `makeStore` is
 * called lazily on the first authorised request, so an unconfigured or unused route builds nothing.
 */
export function mountCredentialCountRoute(
  app: Pick<Express, "use">,
  env: Record<string, string | undefined>,
  makeStore: () => CredentialRowCounter,
  log: (line: string) => void = (line) => console.log(line),
): boolean {
  const resolved = resolveCredentialCountAdminKey(env);
  if (resolved.state === "short") log(CREDENTIAL_COUNT_SHORT_KEY_LOG);
  if (resolved.state !== "on") return false;
  app.use(CREDENTIAL_COUNT_ROUTE_PATH, createCredentialCountRouter(resolved.key, makeStore));
  return true;
}
