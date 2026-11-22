// POST /api/internal/bots/admit: may one of an owner's bots message another? Called only by the bots gateway's
// admission relay (bots/src/bot-admission.ts) with a signed `to-backend` call under BOTS_BACKEND_CALL_SECRET. The owner
// is the signed owner DID and the source is the signed bot; the body must repeat both and names only the target. Both
// bots are looked up in that one owner's record. Details: TC-3809

import express, { type Express } from "express";
import { addressFromOwnerDid, type Admission, type BotEnvironment } from "../bots-registry.js";
import { NonceGuard, verifyCall } from "../bots-signed-call.js";

export const BOT_ADMISSION_PATH = "/api/internal/bots/admit";
/** The bots service's own floor for this secret (bots/src/config.ts): 256 bits as base64url. */
const MIN_SECRET_CHARS = 43;
/** The relay sends at most 512 bytes. */
const MAX_BODY_BYTES = 1024;
const TARGET_KEY = /^(main|[0-9a-f]{32})$/;
/** The only service with the relay. */
const ENVIRONMENT: BotEnvironment = "private";

export interface AdmissionRegistry {
  admit(address: string, sourceKey: string, targetKey: string, callerEnvironment?: BotEnvironment): Promise<Admission>;
}

/** BOTS_BACKEND_CALL_SECRET, when it is set to a 256-bit secret of its own. Anything else leaves the route unmounted. */
export function botAdmissionSecret(env: Record<string, string | undefined>): string | undefined {
  const secret = env.BOTS_BACKEND_CALL_SECRET || undefined;
  if (secret === undefined) return undefined;
  if (secret.length < MIN_SECRET_CHARS || secret === env.BOTS_SERVICE_SECRET) {
    console.warn("[startup] BOTS_BACKEND_CALL_SECRET must be a unique 256-bit secret; bot admission is off.");
    return undefined;
  }
  return secret;
}

function targetOf(body: Buffer, owner: string, sourceKey: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || fields.owner !== owner || fields.sourceKey !== sourceKey) return undefined;
  const { targetKey } = fields;
  return typeof targetKey === "string" && TARGET_KEY.test(targetKey) ? targetKey : undefined;
}

/**
 * Mounted ahead of the JSON parser, CSRF and the shared rate limits: the signature covers the exact body bytes, the
 * gateway sends no CSRF header, and every owner's admissions arrive from the one gateway address. A call that does
 * not verify ends at the signature check, before any record is read. Answers 200 only with the registry's verdict.
 */
export function mountBotAdmissionRoute(app: Express, secret: string, registry: AdmissionRegistry): void {
  const nonces = new NonceGuard();
  app.post(
    BOT_ADMISSION_PATH,
    express.raw({ type: "application/json", limit: MAX_BODY_BYTES, inflate: false }),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      const body = Buffer.isBuffer(req.body) ? req.body : undefined;
      const claims = body && verifyCall(req.get("authorization"), { method: req.method, path: req.originalUrl, body }, {
        secret, direction: "to-backend", environment: ENVIRONMENT, nonces,
      });
      const address = claims ? addressFromOwnerDid(claims.owner) : undefined;
      if (!body || !claims || address === undefined) {
        res.status(401).end();
        return;
      }
      const targetKey = targetOf(body, claims.owner, claims.bot);
      if (targetKey === undefined) {
        res.status(400).end();
        return;
      }
      res.json(await registry.admit(address, claims.bot, targetKey, ENVIRONMENT));
    },
  );
}
