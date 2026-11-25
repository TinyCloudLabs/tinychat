import type { NextFunction, Request, Response } from "express";
import { verifySession } from "@tinyboilerplate/server";

export function createAuthMiddleware(privateKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

    if (!token) {
      res.set("X-TinyCloud-Session-Rejected", "1");
      res.status(401).json({ error: "missing_token", message: "Authorization header is required" });
      return;
    }

    try {
      const { address, renewal } = await verifySession(token, privateKey);
      req.user = renewal ? { address, renewal } : { address };
      next();
    } catch {
      res.set("X-TinyCloud-Session-Rejected", "1");
      res.status(401).json({ error: "invalid_token", message: "Token verification failed" });
    }
  };
}
