/**
 * A read-only status of the hosted AssemblyAI path (`GET /api/internal/assemblyai-status`) for an operator
 * probe: the tinychat backend has no log shipper, so this is the monitor's source. It mirrors the credential
 * count route (routes/credential-count.ts) exactly: the same `x-admin-key` header and the same key
 * (`CREDENTIAL_COUNT_ADMIN_KEY`, no new secret), not registered at all (404) unless that key is valid, a
 * constant-time compare FIRST, a bare 401 for a wrong or missing key, then one of two hard hourly buckets
 * (rate-limits.ts): failure 5/h for wrong keys, success 60/h for the correct one, so guessing cannot lock the
 * probe out. Exhausted buckets answer a bare 429; every response carries `Cache-Control: no-store`.
 *
 * The body is `HostedProviderMonitor.status()`: counts, tokens and timestamps only, never an id, address, key
 * or AssemblyAI text, and it is the same snapshot the heartbeat and the events are cut from. Nothing is
 * logged per request, and the key and header are never logged or echoed.
 *
 * The router is mounted at the app root and carries its own absolute path; without a valid key it has no
 * routes at all, which is the same 404 as an unmounted route.
 */
import { Router } from "express";
import {
  ASSEMBLYAI_STATUS_PATHS,
  createAssemblyAiStatusLimiters,
  type CredentialCountLimiters,
} from "../rate-limits.js";
import { CREDENTIAL_COUNT_ADMIN_KEY_HEADER, adminKeyMatches, resolveCredentialCountAdminKey } from "./credential-count.js";
import type { HostedProviderMonitor } from "../services/assemblyai-hosted-monitor.js";

export const ASSEMBLYAI_STATUS_ROUTE_PATH = ASSEMBLYAI_STATUS_PATHS[0];

export function createAssemblyAiStatusRouter(
  env: Record<string, string | undefined>,
  monitor: Pick<HostedProviderMonitor, "status">,
  limiters: CredentialCountLimiters = createAssemblyAiStatusLimiters(),
): Router {
  const router = Router();
  const resolved = resolveCredentialCountAdminKey(env);
  if (resolved.state !== "on") return router;
  router.get(ASSEMBLYAI_STATUS_ROUTE_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!adminKeyMatches(req.get(CREDENTIAL_COUNT_ADMIN_KEY_HEADER), resolved.key)) {
      if (await limiters.failure(req, res)) res.status(401).end();
      return;
    }
    if (!(await limiters.success(req, res))) return;
    res.status(200).json(monitor.status());
  });
  return router;
}
