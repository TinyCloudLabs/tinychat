// The backend routes a bots service may call with its signed credential (bots-signed-call.ts, `to-backend`). A
// request carrying that credential to any other route is refused here, before any router runs. Each entry is an
// exact method and path, with no query. The never-list in bots/src/tool-policy.ts names what none may reach.
// Details: TC-3795

import type { NextFunction, Request, Response } from "express";

export const BOTS_SERVICE_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  // Sibling admission: may one of the owner's bots message another (bots/src/bot-admission.ts).
  { method: "POST", path: "/api/internal/bots/admit" },
];

/** The bots service's scheme (SIGNED_SCHEME), in any case: HTTP schemes are case-insensitive. */
const BOTS_SERVICE_SCHEME = /^\s*tinycloud-signed(\s|$)/i;

export function botsServiceRouteAllowed(method: string, url: string): boolean {
  return BOTS_SERVICE_ROUTES.some(route => route.method === method && route.path === url);
}

export function botsServiceRouteGuard(req: Request, res: Response, next: NextFunction): void {
  const authorization = req.headers.authorization;
  if (authorization === undefined || !BOTS_SERVICE_SCHEME.test(authorization) || botsServiceRouteAllowed(req.method, req.originalUrl)) {
    next();
    return;
  }
  res.status(403).json({ error: "forbidden" });
}
