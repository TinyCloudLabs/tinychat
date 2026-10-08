import express from "express";
import { isHostedPartPath } from "./routes/assemblyai-hosted.js";

/** Keep delegation acceptance unread until auth and cohort gating have passed. */
export function createApiBodyParser() {
  const parser = express.json({ limit: "1mb" });
  return ((req, res, next) => {
    if (
      (req.method === "POST" && /^\/api\/delegations\/?$/.test(req.path)) ||
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
