import type { RequestHandler } from "express";

export function localValidationFromEnv(env: NodeJS.ProcessEnv): boolean {
  if (env.TINYCHAT_LOCAL_VALIDATION !== "true") return false;
  if (env.NODE_ENV !== "development") {
    throw new Error("Local validation requires NODE_ENV=development");
  }
  for (const key of ["FRONTEND_URL", "ELIZA_SERVICE_URL"] as const) {
    const url = new URL(env[key] ?? "");
    if (!["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new Error(`Local validation requires loopback ${key}`);
    }
  }
  for (const key of [
    "LEDGER_SERVICE_URL", "LEDGER_SERVICE_SECRET", "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET", "TRANSCRIPTION_API_URL", "TRANSCRIPTION_API_KEY",
  ]) {
    if (env[key]) throw new Error(`Local validation requires ${key} unset`);
  }
  for (const key of [
    "LEDGER_AUTHORITATIVE", "CONNECTOR_WEBHOOKS_ENABLED", "GOOGLE_MEET_OAUTH_ENABLED",
    "CONNECTOR_BACKEND_INGEST_ENABLED",
  ]) {
    if (env[key] === "true") throw new Error(`Local validation requires ${key} disabled`);
  }
  return true;
}

/** Local tests use only auth/chat and the existing Eliza session courier. */
export const localValidationGuard: RequestHandler = (req, res, next) => {
  if (/^\/api\/(delegations|connectors|transcriber)(\/|$)/i.test(req.path) ||
      (req.method !== "GET" && /^\/api\/billing(\/|$)/i.test(req.path))) {
    res.status(403).json({ error: "local_validation_write_disabled" });
    return;
  }
  next();
};
