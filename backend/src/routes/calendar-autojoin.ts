import { Router, type Request, type Response } from "express";
import { CalendarAutojoinConnection, CalendarAutojoinError } from "../services/calendar-autojoin-connection.js";
import { GoogleOAuthError } from "../services/google-oauth.js";

/** All routes mount behind session authentication and global CSRF protection. */
export function createCalendarAutojoinRouter(options: { connection: CalendarAutojoinConnection }): Router {
  const router = Router();
  const connection = options.connection;
  const wrap = (run: (tenant: string, req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const tenant = req.user?.address;
    if (typeof tenant !== "string" || !tenant) { res.status(401).json({ error: "unauthorized" }); return; }
    try { await run(tenant.toLowerCase(), req, res); }
    catch (error) {
      if (error instanceof CalendarAutojoinError) { res.status(error.status).json({ error: error.code }); return; }
      if (error instanceof GoogleOAuthError) {
        const permanent = ["invalid_grant", "invalid_identity", "access_denied", "invalid_scope"].includes(error.error);
        res.status(permanent ? 400 : 503).json({ error: permanent ? error.error : "google_unavailable" }); return;
      }
      // Only fixed codes; Google errors and request payloads can contain credentials.
      res.status(503).json({ error: "calendar_autojoin_unavailable" });
    }
  };
  router.get("/status", wrap(async (tenant, _req, res) => { res.json(await connection.getStatus(tenant)); }));
  router.post("/begin", wrap(async (tenant, req, res) => {
    const { state, challenge, consent } = req.body ?? {};
    if (typeof state !== "string" || typeof challenge !== "string" || consent !== true) {
      throw new CalendarAutojoinError("invalid_request", 400);
    }
    res.json(await connection.begin(tenant, { state, challenge, consent }));
  }));
  router.post("/exchange", wrap(async (tenant, req, res) => {
    const { state, code, verifier } = req.body ?? {};
    if (typeof state !== "string" || state.length > 512 || typeof code !== "string" || !code || code.length > 2048
      || typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      throw new CalendarAutojoinError("invalid_request", 400);
    }
    res.json(await connection.exchange(tenant, { state, code, verifier }));
  }));
  router.post("/enable", wrap(async (tenant, req, res) => {
    const { setupId } = req.body ?? {};
    if (typeof setupId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(setupId)) throw new CalendarAutojoinError("invalid_request", 400);
    res.json(await connection.enable(tenant, setupId));
  }));
  router.post("/disable", wrap(async (tenant, _req, res) => { res.json(await connection.disable(tenant)); }));
  router.post("/disconnect", wrap(async (tenant, req, res) => {
    const token = req.body?.token;
    if (token !== undefined && (typeof token !== "string" || token.length === 0 || token.length > 4096)) {
      throw new CalendarAutojoinError("invalid_request", 400);
    }
    const result = await connection.disconnect(tenant, token);
    res.status(result.upstreamRevoked === "failed" ? 502 : 200).json(result);
  }));
  return router;
}
