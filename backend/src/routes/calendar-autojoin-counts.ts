/**
 * TC-916: a read-only count of calendar auto-join connections (`GET /api/internal/calendar-autojoin-counts`)
 * so an operator who cannot read backend logs can see how many live connections carry the Google `email`
 * grant that transcript sharing needs, and how many owners would have to reconnect for it.
 *
 * It mirrors the AssemblyAI status route (routes/assemblyai-status.ts) exactly: the same `x-admin-key` header
 * and key (`CREDENTIAL_COUNT_ADMIN_KEY`, no new secret), no routes at all (404) unless that key is valid, a
 * constant-time compare FIRST, a bare 401 for a wrong or missing key, then the credential count's two hard
 * hourly buckets (failure 5/h, success 10/h). Every response carries `Cache-Control: no-store`.
 *
 * The body is five counts and nothing else: never a tenant, address, email, subject or scope string. A
 * listing failure answers a bare 503. Nothing is logged per request; the key and header are never logged.
 */
import { Router } from "express";
import {
  CALENDAR_AUTOJOIN_COUNTS_PATHS,
  createCredentialCountLimiters,
  type CredentialCountLimiters,
} from "../rate-limits.js";
import { CREDENTIAL_COUNT_ADMIN_KEY_HEADER, adminKeyMatches, resolveCredentialCountAdminKey } from "./credential-count.js";
import type { CalendarConnection } from "../services/calendar-autojoin-store.js";

export const CALENDAR_AUTOJOIN_COUNTS_ROUTE_PATH = CALENDAR_AUTOJOIN_COUNTS_PATHS[0];

export interface CalendarAutojoinCounts {
  connections: number;
  enabled: number;
  enabled_with_email_scope_granted: number;
  enabled_with_verified_email: number;
  enabled_needing_reconnect: number;
}

export function countCalendarAutojoinConnections(rows: readonly CalendarConnection[]): CalendarAutojoinCounts {
  const enabled = rows.filter(row => row.state === "enabled");
  const verified = enabled.filter(row => !!row.verifiedEmail).length;
  return {
    connections: rows.length,
    enabled: enabled.length,
    // Google reports the `email` grant as the userinfo URL; the short form is accepted too.
    enabled_with_email_scope_granted: enabled.filter(row => row.scopes.some(scope =>
      scope === "email" || scope === "https://www.googleapis.com/auth/userinfo.email")).length,
    enabled_with_verified_email: verified,
    enabled_needing_reconnect: enabled.length - verified,
  };
}

export function createCalendarAutojoinCountsRouter(
  env: Record<string, string | undefined>,
  store: { listConnections(): Promise<CalendarConnection[]> },
  limiters: CredentialCountLimiters = createCredentialCountLimiters(),
): Router {
  const router = Router();
  const resolved = resolveCredentialCountAdminKey(env);
  if (resolved.state !== "on") return router;
  router.get(CALENDAR_AUTOJOIN_COUNTS_ROUTE_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!adminKeyMatches(req.get(CREDENTIAL_COUNT_ADMIN_KEY_HEADER), resolved.key)) {
      if (await limiters.failure(req, res)) res.status(401).end();
      return;
    }
    if (!(await limiters.success(req, res))) return;
    let rows: CalendarConnection[];
    try {
      rows = await store.listConnections();
    } catch {
      res.status(503).end();
      return;
    }
    res.status(200).json(countCalendarAutojoinConnections(rows));
  });
  return router;
}
