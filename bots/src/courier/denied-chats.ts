// Defence in depth for Courier turns; the backend independently filters every chat tool result.
import { backendCallHeaders } from "../backend-call";
import { DEFAULT_BACKEND_ORIGIN } from "../config";
import { readBody } from "../gateway";
import { OWNER_DID } from "../owner";
import { parseAreas, type ReadArea } from "../reads";
import { signedCallHeader } from "../signed-call";

const PATH = "/api/internal/bots/main/reads/read_status";
const TIMEOUT_MS = 10_000;

export interface CourierReadStatus { enabledReadAreas: ReadArea[]; deniedChatIds: Set<string> }

/** Fresh owner settings, never cached. Any lookup failure must stop the caller's chat read. */
export async function readStatus(owner: string): Promise<CourierReadStatus> {
  const secret = process.env.BOTS_BACKEND_CALL_SECRET;
  const rawOrigin = process.env.BACKEND_ORIGIN?.trim() || DEFAULT_BACKEND_ORIGIN;
  const origin = URL.parse(rawOrigin);
  if (!OWNER_DID.test(owner) || !secret || secret.length < 43 || !origin || origin.protocol !== "https:"
    || (rawOrigin !== origin.origin && rawOrigin !== `${origin.origin}/`)) throw new Error("denied_chats_unavailable");
  const body = JSON.stringify({});
  const authorization = signedCallHeader(secret, {
    direction: "to-backend", environment: "private", owner, bot: "main", method: "POST", path: PATH, body,
  });
  const response = await fetch(`${origin.origin}${PATH}`, {
    method: "POST", headers: backendCallHeaders(authorization), body,
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error("denied_chats_unavailable");
  }
  const bytes = await readBody(response, 256 * 1024, TIMEOUT_MS);
  if (typeof bytes === "string") throw new Error("denied_chats_unavailable");
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const ids = (payload as { deniedChatIds?: unknown } | null)?.deniedChatIds;
  const areas = parseAreas((payload as { enabledReadAreas?: unknown } | null)?.enabledReadAreas);
  if (!areas || !Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128)) {
    throw new Error("denied_chats_unavailable");
  }
  return { enabledReadAreas: areas, deniedChatIds: new Set(ids) };
}

export async function deniedChatIds(owner: string): Promise<Set<string>> {
  return (await readStatus(owner)).deniedChatIds;
}

export async function enabledReadAreas(owner: string): Promise<ReadArea[]> {
  return (await readStatus(owner)).enabledReadAreas;
}
