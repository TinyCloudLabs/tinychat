// Owner-only title picker for C5's per-chat exclusions. This is not a bot read endpoint.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import { BotsError, BotsRouteMissing } from "./botsApi";
import type { ChatReadChat } from "./chatReadAccessApi";
const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
export async function listTelegramChats(tcw: TinyCloudWeb): Promise<ChatReadChat[]> {
  const session = tcw.session();
  const stored = new SessionStore("xyz.tinycloud.tinychat:session");
  const token = stored.getToken();
  if (!session || !token || stored.getAddress()?.toLowerCase() !== session.address.toLowerCase()) throw new BotsError("signed_out");
  const response = await fetch(`${base}/api/bots/main/reads/telegram/chats`, {
    headers: { authorization: `Bearer ${token}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE }, cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) throw new BotsRouteMissing();
  if (response.status === 401) throw new BotsError("signed_out");
  if (!response.ok) throw new BotsError("failed");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("chats" in payload) || !Array.isArray(payload.chats)) throw new BotsError("failed");
  return payload.chats.map((chat: unknown) => {
    if (!chat || typeof chat !== "object" || !("chat" in chat) || typeof chat.chat !== "string" || !("title" in chat) || typeof chat.title !== "string") throw new BotsError("failed");
    return { id: chat.chat, title: chat.title };
  });
}
