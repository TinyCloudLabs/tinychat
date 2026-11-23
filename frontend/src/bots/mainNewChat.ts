// The owner's "Start a new chat" with Main: the service clears Main's conversation and the questions it is waiting on,
// and keeps the owner's settings and saved history. Only the owner's tap calls this. Details: TC-3808
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import { BotsError, BotsRouteMissing } from "./botsApi";

/** `busy`: a reply is in progress. `archive_pending`: messages are still being saved to the owner's history. */
export type NewChatOutcome = "cleared" | "busy" | "archive_pending";

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;

/** Resolves with the outcome; throws BotsError for anything else and BotsRouteMissing when the account has no such route. */
export async function newMainChat(fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): Promise<NewChatOutcome> {
  const token = new SessionStore("xyz.tinycloud.tinychat:session").getToken();
  if (!token) throw new BotsError("signed_out");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/bots/main/new-chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new BotsError("failed");
  }
  if (response.status === 401) throw new BotsError("signed_out");
  if (response.status === 404) throw new BotsRouteMissing();
  const payload = (await response.json().catch(() => null)) as { outcome?: unknown; error?: unknown } | null;
  if (response.ok && payload?.outcome === "cleared") return "cleared";
  if (response.status === 409 && (payload?.error === "busy" || payload?.error === "archive_pending")) return payload.error;
  throw new BotsError("failed");
}
