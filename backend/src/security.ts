import type { Express } from "express";
import type { RequestHandler } from "express";
import helmet from "helmet";

export function applySecurityDefaults(app: Express) {
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }) as unknown as RequestHandler,
  );
}
