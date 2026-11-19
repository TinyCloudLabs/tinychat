// Messages and the history expiry notice of any one bot, by its key (TC-3325). Main's addresses are the ones its
// chat over Home uses today; another bot's are the same routes with its key in place of `main`. The owner is always
// the session's: these calls carry only the session bearer.
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import { BotsError, createMainEventParser, toActivity, type BotActivity, type BotMessage, type MainEvent } from "./botsApi";
import type { HistoryNotice } from "./historyNotice";
import { createBotRosterApi, type BotRosterApi } from "./botRosterApi";

/** `main`, or the 32 lower-case hex characters the backend chose. Checked before any address is built from it. */
export const BOT_KEY = /^(?:main|[0-9a-f]{32})$/;

/** A bot's earlier messages, with the activity lines the service holds beside them. */
export interface BotConversation {
  messages: BotMessage[];
  activity: BotActivity[];
}

export interface BotChatApi {
  listMessages(key: string, signal?: AbortSignal): Promise<BotMessage[]>;
  /** The same read as `listMessages`, with the activity records. Absent: the view shows no activity lines. */
  listConversation?(key: string, signal?: AbortSignal): Promise<BotConversation>;
  /** Resolves after the stream's `done` or `error` event; throws BotsError when the stream fails or ends without one. */
  send(key: string, text: string, onEvent: (event: MainEvent) => void, signal?: AbortSignal): Promise<void>;
  /** The bot's expiry notice, or null when there is none (or the history routes are off). */
  readNotice(key: string): Promise<HistoryNotice | null>;
  acknowledgeNotice(key: string, notice: HistoryNotice, renderedAt: number): Promise<HistoryNotice>;
}

export interface BotChatApiOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: typeof fetch;
}

function botPath(key: string): string {
  if (!BOT_KEY.test(key)) throw new BotsError("failed");
  return `/api/bots/${key}`;
}

/** Main's notice keeps its address from before there were other bots. */
const noticePath = (key: string) => (key === "main" ? "/api/bots/history/notice" : `${botPath(key)}/history/notice`);

/** A JSON value's fields, each still unknown: any non-null object may be read this way. */
function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toMessages(payload: unknown): BotMessage[] {
  const list = fields(payload).messages;
  if (!Array.isArray(list)) throw new BotsError("failed");
  return list.flatMap((item: unknown) => {
    const value = fields(item);
    return typeof value.id === "string" && (value.role === "user" || value.role === "bot") && typeof value.text === "string"
      ? [{ id: value.id, role: value.role, text: value.text, at: typeof value.at === "string" ? value.at : "" }]
      : [];
  });
}

/** The activity records of a list response: each one that has the service's exact shape, in the service's order. */
function toActivities(payload: unknown): BotActivity[] {
  const list = fields(payload).activity;
  return Array.isArray(list) ? list.flatMap((item: unknown) => toActivity(item) ?? []) : [];
}

/** A value the backend may leave out; when present it must be a number. */
const optionalNumber = (value: unknown) => value === undefined || typeof value === "number";

/** The notice the backend sent, or null for none; a malformed one fails the read. */
function toNotice(value: unknown): HistoryNotice | null {
  if (value === null || value === undefined) return null;
  const notice = fields(value);
  if (typeof notice.id !== "string" || typeof notice.expiresAt !== "number" || typeof notice.firstAttemptAt !== "number"
    || !optionalNumber(notice.deliveredAt) || !optionalNumber(notice.deleteAt)) throw new BotsError("failed");
  return {
    id: notice.id,
    expiresAt: notice.expiresAt,
    firstAttemptAt: notice.firstAttemptAt,
    ...(typeof notice.deliveredAt === "number" ? { deliveredAt: notice.deliveredAt } : {}),
    ...(typeof notice.deleteAt === "number" ? { deleteAt: notice.deleteAt } : {}),
  };
}

export function createBotChatApi({ baseUrl, getToken, fetch: fetchImpl = (input, init) => globalThis.fetch(input, init) }: BotChatApiOptions): BotChatApi {
  const base = baseUrl.replace(/\/$/, "");

  async function request(method: "GET" | "POST", path: string, init: { signal?: AbortSignal; body?: unknown; cache?: RequestCache } = {}): Promise<Response> {
    const token = getToken();
    if (!token) throw new BotsError("signed_out");
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
        signal: init.signal,
        cache: init.cache,
      });
    } catch {
      init.signal?.throwIfAborted();
      throw new BotsError("failed");
    }
    if (response.status === 401) throw new BotsError("signed_out");
    return response;
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new BotsError("failed");
    }
  }

  async function listConversation(key: string, signal?: AbortSignal): Promise<BotConversation> {
    const response = await request("GET", `${botPath(key)}/messages`, { signal });
    if (!response.ok) throw new BotsError("failed");
    const payload = await readJson(response);
    return { messages: toMessages(payload), activity: toActivities(payload) };
  }

  return {
    async listMessages(key, signal) {
      return (await listConversation(key, signal)).messages;
    },

    listConversation,

    async send(key, text, onEvent, signal) {
      const response = await request("POST", `${botPath(key)}/messages`, { signal, body: { text } });
      if (response.status === 400) throw new BotsError("invalid");
      // The backend's own `message` is never shown: only its code picks the owner's line (botsStrings.ts).
      if (!response.ok) {
        const code = fields(await response.json().catch(() => null)).error;
        throw new BotsError(code === "bot_unavailable" ? "bot_unavailable" : "failed");
      }
      if (!response.body) throw new BotsError("failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let ended = false;
      const push = createMainEventParser((event) => {
        if (ended) return;
        if (event.type === "done" || event.type === "error") ended = true;
        onEvent(event);
      });
      try {
        while (!ended) {
          const { done, value } = await reader.read();
          if (done) {
            push(decoder.decode());
            break;
          }
          push(decoder.decode(value, { stream: true }));
        }
      } catch (cause) {
        signal?.throwIfAborted();
        throw cause instanceof BotsError ? cause : new BotsError("failed");
      } finally {
        void reader.cancel().catch(() => {});
      }
      if (!ended) throw new BotsError("failed");
    },

    async readNotice(key) {
      const response = await request("GET", noticePath(key), { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new BotsError("failed");
      const notice = toNotice(fields(await readJson(response)).notice);
      return notice ? { ...notice, renderAttemptAt: Date.now() } : null;
    },

    async acknowledgeNotice(key, notice, renderedAt) {
      const response = await request("POST", `${noticePath(key)}/ack`, { body: { id: notice.id, renderedAt }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new BotsError("failed");
      const acknowledged = toNotice(fields(await readJson(response)).notice);
      if (!acknowledged) throw new BotsError("failed");
      return acknowledged;
    },
  };
}

// Same backend origin and session store as botsApi.ts.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const SESSION_STORE_KEY = "xyz.tinycloud.tinychat:session";

export const botChatApi: BotChatApi = createBotChatApi({
  baseUrl: BACKEND_URL,
  getToken: () => new SessionStore(SESSION_STORE_KEY).getToken(),
});

/** The account's bots (S3's client), on the same origin and session. */
export const botRosterApi: BotRosterApi = createBotRosterApi({
  baseUrl: BACKEND_URL,
  getToken: () => new SessionStore(SESSION_STORE_KEY).getToken(),
});
