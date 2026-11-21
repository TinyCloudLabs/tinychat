import { hkdfSync } from "node:crypto";
import { join } from "node:path";
import { readBody, type UpstreamFetch } from "./gateway";
import { isRecord } from "./guards";
import { isBotKey } from "./owner";
import { NonceGuard, signedCallHeader, SIGNED_SCHEME, verifyCall } from "./signed-call";

export const ADMISSION_CONTROL_PATH = "/admit";
const BACKEND_PATH = "/api/internal/bots/admit";
export const MAX_ADMISSION_BYTES = 512;
const BODY_TIMEOUT_MS = 1_000;
const UPSTREAM_TIMEOUT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 5_000;
const ENVIRONMENT = "private";

export function admissionControlKey(backendSecret: string): string {
  return Buffer.from(hkdfSync("sha256", backendSecret, "", "bots-control-socket/v1", 32)).toString("base64url");
}

const REFUSALS = [
  "unknown_source", "unknown_target", "same_bot", "source_not_active",
  "target_not_active", "different_environment", "unavailable",
] as const;
type Admission = { admitted: true } | { admitted: false; reason: (typeof REFUSALS)[number] };
export type BotAdmission = (owner: string, sourceKey: string, targetKey: string) => Promise<Admission>;
const REFUSED: Admission = { admitted: false, reason: "unavailable" };

async function readVerdict(response: Response): Promise<Admission> {
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    return REFUSED;
  }
  const bytes = await readBody(response, MAX_ADMISSION_BYTES, BODY_TIMEOUT_MS);
  if (typeof bytes === "string") return REFUSED;
  const decision: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(decision)) return REFUSED;
  if (decision.admitted === true) return { admitted: true };
  const reason = REFUSALS.find(allowed => decision.reason === allowed);
  return decision.admitted === false && reason ? { admitted: false, reason } : REFUSED;
}

function admissionHeaders(secret: string, path: string, owner: string, sourceKey: string, body: string): Record<string, string> {
  const authorization = signedCallHeader(secret, {
    direction: "to-backend", environment: ENVIRONMENT, owner, bot: sourceKey, method: "POST", path, body,
  });
  return { authorization, "content-type": "application/json" };
}

/** The supervisor has no outbound network. It asks the gateway through the supervisor-only Unix socket. */
export function createAdmissionClient(egressRoot: string, controlKey: string, send = fetch): BotAdmission {
  const unix = join(egressRoot, "control.sock");
  return async (owner, sourceKey, targetKey) => {
    try {
      const body = JSON.stringify({ owner, sourceKey, targetKey });
      return await readVerdict(await send(`http://gateway${ADMISSION_CONTROL_PATH}`, {
        method: "POST", unix, redirect: "error", signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        headers: admissionHeaders(controlKey, ADMISSION_CONTROL_PATH, owner, sourceKey, body), body,
      }));
    } catch {
      return REFUSED;
    }
  };
}

/** Installed only on the control socket. Forward a newly built request to the configured backend. */
export function createAdmissionRelay(origin: string, backendSecret: string | undefined, send: UpstreamFetch = fetch) {
  const controlKey = backendSecret ? admissionControlKey(backendSecret) : undefined;
  const nonces = new NonceGuard();
  return async (req: Request): Promise<Response> => {
    const { pathname, search } = new URL(req.url);
    if (pathname !== ADMISSION_CONTROL_PATH || search) return new Response(null, { status: 404 });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const auth = req.headers.get("authorization");
    if (!backendSecret || !controlKey || !auth?.startsWith(SIGNED_SCHEME)) return new Response(null, { status: 401 });
    try {
      const bytes = await readBody(req, MAX_ADMISSION_BYTES, BODY_TIMEOUT_MS);
      if (bytes === "too_large") return new Response(null, { status: 413 });
      if (bytes === "timeout") return new Response(null, { status: 408 });
      const claims = verifyCall(auth, { method: req.method, path: pathname, body: bytes }, {
        secret: controlKey, direction: "to-backend", environment: ENVIRONMENT, nonces,
      });
      if (!claims) return new Response(null, { status: 401 });
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(value) || Object.keys(value).length !== 3) return new Response(null, { status: 400 });
      const { owner, bot: sourceKey } = claims;
      const { targetKey } = value;
      if (value.owner !== owner || value.sourceKey !== sourceKey || typeof targetKey !== "string"
        || !isBotKey(targetKey) || sourceKey === targetKey) {
        return new Response(null, { status: 400 });
      }
      const body = JSON.stringify({ owner, sourceKey, targetKey });
      const response = await send(`${origin}${BACKEND_PATH}`, {
        method: "POST", headers: admissionHeaders(backendSecret, BACKEND_PATH, owner, sourceKey, body), redirect: "error", body,
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
      return Response.json(await readVerdict(response));
    } catch {
      return Response.json(REFUSED);
    }
  };
}
