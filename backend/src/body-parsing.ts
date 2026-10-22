import express from "express";
import { isHostedPartPath } from "./routes/assemblyai-hosted.js";

/** Keep delegation acceptance unread until auth and cohort gating have passed. */
export function createApiBodyParser() {
  const parser = express.json({ limit: "1mb" });
  return ((req, res, next) => {
    if (
      // Any slash run: Express also routes `/api/delegations//` to the delegation POST handler.
      // The exo grant POST is exempt for the same reason: its route-local parser sets the limit.
      (req.method === "POST" && (/^\/api\/delegations\/*$/i.test(req.path) || /^\/api\/exo\/v1\/grant\/*$/i.test(req.path))) ||
      req.path === "/api/nras-proxy" ||
      req.path.startsWith("/api/nras-proxy/") ||
      isHostedPartPath(req.path)
    ) {
      next();
      return;
    }
    parser(req, res, next);
  }) satisfies express.RequestHandler;
}
