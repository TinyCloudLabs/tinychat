import type { Express } from "express";
import { contentMasterFingerprint } from "../services/content-store.js";
import { adminKeyMatches, resolveCredentialCountAdminKey } from "./credential-count.js";
import { createCredentialCountLimiters } from "../rate-limits.js";

export function mountContentContinuityRoute(
  app: Pick<Express, "get">,
  env: NodeJS.ProcessEnv,
  master: string,
  backendDid: string,
  probe: () => Promise<{ ok: boolean; id: string | null }>,
): void {
  const admin = resolveCredentialCountAdminKey(env);
  if (admin.state !== "on") return;
  const limiters = createCredentialCountLimiters();
  app.get("/api/ops/content-continuity", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!adminKeyMatches(req.get("x-admin-key"), admin.key)) {
      if (await limiters.failure(req, res)) res.status(401).end();
      return;
    }
    if (!(await limiters.success(req, res))) return;
    if (!master.trim()) {
      res.status(503).json({ error: "content_master_unset", backendDid, index: { ok: false, id: null } });
      return;
    }
    let index: { ok: boolean; id: string | null };
    try { index = await probe(); } catch { index = { ok: false, id: null }; }
    res.json({ contentMasterSha256: contentMasterFingerprint(master), backendDid, index });
  });
}
