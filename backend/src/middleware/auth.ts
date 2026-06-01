import type { NextFunction, Request, Response } from "express";
import { verifySessionToken } from "@tinyboilerplate/server";

export function createAuthMiddleware(privateKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

    if (!token) {
      res.status(401).json({ error: "missing_token", message: "Authorization header is required" });
      return;
    }

    try {
      const { address } = await verifySessionToken(token, privateKey);
      req.user = { address };
      next();
    } catch {
      res.status(401).json({ error: "invalid_token", message: "Token verification failed" });
    }
  };
}
