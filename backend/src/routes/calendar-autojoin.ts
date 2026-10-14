import { Router, type Request, type Response } from "express";
import { CalendarAutojoinConnection, CalendarAutojoinError } from "../services/calendar-autojoin-connection.js";
import { GoogleOAuthError, googleOAuthNativeReturnEnabled } from "../services/google-oauth.js";

/** All routes mount behind session authentication and global CSRF protection. */
export function createCalendarAutojoinRouter(options: { connection: CalendarAutojoinConnection; nativeReturn?: boolean }): Router {
  const router = Router();
  const connection = options.connection;
  // Exo app (`native.`) states only while the native OAuth return is on (TC-521, see google-oauth.ts).
  const nativeReturn = options.nativeReturn ?? googleOAuthNativeReturnEnabled();
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
  router.get("/status", async (req: Request, res: Response) => {
    const started = performance.now();
    const metrics = { reads: 0 };
    const finish = (outcome: "ok" | "stale" | "unavailable") => {
      const ms = Math.max(0, Math.round(performance.now() - started));
      res.setHeader("Server-Timing", `status;dur=${ms};desc="reads=${metrics.reads}"`);
      console.log(`[calendar-autojoin] code=status_read outcome=${outcome} ms=${ms} reads=${metrics.reads}`);
    };
    res.setHeader("Cache-Control", "no-store");
    const address = req.user?.address;
    if (typeof address !== "string" || !address) {
      finish("unavailable");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tenant = address.toLowerCase();
    try {
      const status = await connection.getStatus(tenant, metrics);
      finish("ok");
      res.json(status);
    } catch (error) {
      // Preserve explicit domain/authorization errors and corrupt-state behaviour. Never log errors.
      const domainError = error instanceof CalendarAutojoinError || error instanceof GoogleOAuthError;
      const invalidState = error instanceof Error
        && ["calendar_state_invalid", "calendar_listing_invalid"].includes(error.message);
      const cached = !domainError && !invalidState ? connection.getLastGoodStatus(tenant) : undefined;
      if (cached) {
        finish("stale");
        res.json({ ...cached.body, stale: true, asOf: cached.asOf });
        return;
      }
      finish("unavailable");
      if (error instanceof CalendarAutojoinError) { res.status(error.status).json({ error: error.code }); return; }
      if (error instanceof GoogleOAuthError) {
        const permanent = ["invalid_grant", "invalid_identity", "access_denied", "invalid_scope"].includes(error.error);
        res.status(permanent ? 400 : 503).json({ error: permanent ? error.error : "google_unavailable" }); return;
      }
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: "calendar_autojoin_unavailable" });
    }
  });
  router.post("/begin", wrap(async (tenant, req, res) => {
    const { state, challenge, consent } = req.body ?? {};
    if (typeof state !== "string" || typeof challenge !== "string" || consent !== true
      || (!nativeReturn && state.startsWith("native."))) {
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
