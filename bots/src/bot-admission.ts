import { join } from "node:path";
import { readBody, type UpstreamFetch } from "./gateway";
import { isRecord } from "./guards";
import { bearerMatches, isBotKey, OWNER_DID } from "./owner";

export const ADMISSION_CONTROL_PATH = "/admit";
const BACKEND_PATH = "/api/internal/bots/admit";
export const MAX_ADMISSION_BYTES = 512;
const BODY_TIMEOUT_MS = 1_000;
const UPSTREAM_TIMEOUT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 5_000;

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

function admissionHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

/** The supervisor has no outbound network. It asks the gateway through the supervisor-only Unix socket. */
export function createAdmissionClient(egressRoot: string, secret: string, send = fetch): BotAdmission {
  const unix = join(egressRoot, "control.sock");
  return async (owner, sourceKey, targetKey) => {
    try {
      return await readVerdict(await send(`http://gateway${ADMISSION_CONTROL_PATH}`, {
        method: "POST", unix, redirect: "error", signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        headers: admissionHeaders(secret), body: JSON.stringify({ owner, sourceKey, targetKey }),
      }));
    } catch {
      return REFUSED;
    }
  };
}

/** Installed only on the control socket. Forward a newly built request to the configured backend. */
export function createAdmissionRelay(origin: string, secret: string | undefined, send: UpstreamFetch = fetch) {
  return async (req: Request): Promise<Response> => {
    const { pathname, search } = new URL(req.url);
    if (pathname !== ADMISSION_CONTROL_PATH || search) return new Response(null, { status: 404 });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    if (!secret || !bearerMatches(req.headers.get("authorization"), secret)) return new Response(null, { status: 401 });
    try {
      const bytes = await readBody(req, MAX_ADMISSION_BYTES, BODY_TIMEOUT_MS);
      if (bytes === "too_large") return new Response(null, { status: 413 });
      if (bytes === "timeout") return new Response(null, { status: 408 });
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(value) || Object.keys(value).length !== 3) return new Response(null, { status: 400 });
      const { owner, sourceKey, targetKey } = value;
      if (typeof owner !== "string" || !OWNER_DID.test(owner) || typeof sourceKey !== "string" || !isBotKey(sourceKey)
        || typeof targetKey !== "string" || !isBotKey(targetKey) || sourceKey === targetKey) {
        return new Response(null, { status: 400 });
      }
      const response = await send(`${origin}${BACKEND_PATH}`, {
        method: "POST", headers: admissionHeaders(secret), redirect: "error",
        body: JSON.stringify({ owner, sourceKey, targetKey }),
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
      return Response.json(await readVerdict(response));
    } catch {
      return Response.json(REFUSED);
    }
  };
}
