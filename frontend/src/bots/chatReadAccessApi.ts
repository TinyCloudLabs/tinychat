// The owner's per-chat exclusions, separate from the Feed and chats area grant.
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import { BotsError, BotsRouteMissing } from "./botsApi";

export interface ChatReadChat {
  id: string;
  title?: string | null;
}

export interface ChatReadAccessApi {
  /** Lists chats with the owner's browser authority, not TrustBot's filtered read access. */
  listChats(): Promise<ChatReadChat[]>;
  readDeniedChatIds(): Promise<Set<string>>;
  setChatDenied(chat: string, denied: boolean): Promise<Set<string>>;
}

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;

async function request(method: "GET" | "PUT", path: string, body?: { denied: boolean }): Promise<Set<string>> {
  const token = new SessionStore("xyz.tinycloud.tinychat:session").getToken();
  if (!token) throw new BotsError("signed_out");
  let response: Response;
  try {
    response = await fetch(`${base}/api/bots/main/reads/chats/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BotsError("failed");
  }
  if (response.status === 401) throw new BotsError("signed_out");
  if (response.status === 400) throw new BotsError("invalid");
  if (response.status === 404) throw new BotsRouteMissing();
  if (!response.ok) throw new BotsError("failed");
  const payload: unknown = await response.json().catch(() => null);
  const ids = (payload as { deniedChatIds?: unknown } | null)?.deniedChatIds;
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) throw new BotsError("failed");
  return new Set(ids);
}

export function readDeniedChatIds(): Promise<Set<string>> {
  return request("GET", "denied");
}

export function setChatDenied(chat: string, denied: boolean): Promise<Set<string>> {
  return request("PUT", encodeURIComponent(chat), { denied });
}
