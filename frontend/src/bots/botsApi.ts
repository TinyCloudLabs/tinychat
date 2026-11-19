// Client for the tiny bots routes (TC-2808, docs/plans/tiny-bots-slice1.md): the backend proxies them
// to the bots service with the owner taken from the session, so these calls carry only the session bearer.
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import type { BotsErrorCode } from "./botsStrings";

export interface BotMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  at: string;
}

/** What a bot did on its computer, as the service records it: fixed verbs and counts, never words the model wrote. */
export interface BotActivity {
  id: string;
  verb: "ran_commands" | "changed_files";
  count: number;
  at: string;
}

/** One event of Main's reply stream. Error codes are the service's; anything else arrives as `failed`. */
export type MainEvent =
  | { type: "status"; state: "starting" | "working" }
  | { type: "delta"; text: string }
  | { type: "activity"; activity: BotActivity }
  | { type: "done"; messageId: string }
  | { type: "error"; code: BotsErrorCode };

export class BotsError extends Error {
  constructor(readonly code: BotsErrorCode) {
    super(`Bots request failed: ${code}`);
    this.name = "BotsError";
  }
}

export type MainWebMode = "off" | "listed" | "any";

/** Main's web access setting, as the service reports it. `hosts` is the owner's list, used only in `listed` mode. */
export interface MainWebSettings {
  mode: MainWebMode;
  hosts: string[];
  /** False when the service has no search provider, so no on-preset can work. */
  available: boolean;
  today: { searches: number; pages: number; blocked: number };
}

export interface BotsApi {
  getBotsStatus(signal?: AbortSignal): Promise<{ enabled: boolean }>;
  listMainMessages(signal?: AbortSignal): Promise<BotMessage[]>;
  getMainWeb(signal?: AbortSignal): Promise<MainWebSettings>;
  /** Resolves with the stored setting; throws BotsError("invalid") when the service refuses the list. */
  setMainWeb(settings: Pick<MainWebSettings, "mode" | "hosts">, signal?: AbortSignal): Promise<MainWebSettings>;
  /** Resolves after the stream's `done` or `error` event; throws BotsError when the stream fails or ends without one. */
  sendToMain(text: string, onEvent: (event: MainEvent) => void, signal?: AbortSignal): Promise<void>;
}

const STREAM_ERROR_CODES: Record<string, BotsErrorCode> = {
  bot_unavailable: "bot_unavailable",
  model_unavailable: "model_unavailable",
  busy: "busy",
  at_capacity: "at_capacity",
  invalid: "invalid",
};

/** A JSON value's fields, each still unknown: any non-null object may be read this way. */
function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The record when it has exactly the service's shape; anything else is not an activity line. */
export function toActivity(value: unknown): BotActivity | null {
  const record = fields(value);
  if (record.type !== "activity" || Object.keys(record).length !== 5) return null;
  const { id, verb, count, at } = record;
  return typeof id === "string" && /^[a-f0-9]{32}$/.test(id)
    && (verb === "ran_commands" || verb === "changed_files")
    && typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= 256
    && typeof at === "string" && Number.isFinite(Date.parse(at))
    ? { id, verb, count, at }
    : null;
}

function toEvent(name: string, data: string): MainEvent | null {
  if (name !== "status" && name !== "delta" && name !== "activity" && name !== "done" && name !== "error") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new BotsError("failed");
  }
  const value = fields(parsed);
  // An activity line is a note beside the reply: one that does not check out is left out, and the turn goes on.
  if (name === "activity") {
    const activity = toActivity(value);
    return activity ? { type: "activity", activity } : null;
  }
  if (name === "status" && (value.state === "starting" || value.state === "working")) return { type: "status", state: value.state };
  if (name === "delta" && typeof value.text === "string") return { type: "delta", text: value.text };
  if (name === "done" && typeof value.messageId === "string") return { type: "done", messageId: value.messageId };
  if (name === "error") {
    const code = (typeof value.code === "string" && Object.hasOwn(STREAM_ERROR_CODES, value.code) && STREAM_ERROR_CODES[value.code]) || "failed";
    return { type: "error", code };
  }
  throw new BotsError("failed");
}

/**
 * An incremental `text/event-stream` parser: feed it decoded text in any chunking; it calls
 * `onEvent` once per complete event. Unknown event names are skipped; a malformed known event throws.
 */
export function createMainEventParser(onEvent: (event: MainEvent) => void): (chunk: string) => void {
  let buffer = "";
  let name = "";
  let data: string[] = [];
  const line = (raw: string) => {
    if (raw === "") {
      const event = data.length ? toEvent(name || "message", data.join("\n")) : null;
      name = "";
      data = [];
      if (event) onEvent(event);
      return;
    }
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    const value = colon < 0 ? "" : raw.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  };
  return (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      line(raw);
    }
  };
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

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function toWebSettings(payload: unknown): MainWebSettings {
  const value = fields(payload);
  const { mode, hosts, available } = value;
  const today = fields(value.today);
  if (
    (mode !== "off" && mode !== "listed" && mode !== "any") ||
    !Array.isArray(hosts) || !hosts.every((host): host is string => typeof host === "string") ||
    typeof available !== "boolean" ||
    !isCount(today.searches) || !isCount(today.pages) || !isCount(today.blocked)
  ) throw new BotsError("failed");
  return { mode, hosts: [...hosts], available, today: { searches: today.searches, pages: today.pages, blocked: today.blocked } };
}

export interface BotsApiOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: typeof fetch;
}

export function createBotsApi({ baseUrl, getToken, fetch: fetchImpl = (input, init) => globalThis.fetch(input, init) }: BotsApiOptions): BotsApi {
  const base = baseUrl.replace(/\/$/, "");

  async function request(method: "GET" | "POST" | "PUT", path: string, signal?: AbortSignal, body?: string): Promise<Response> {
    const token = getToken();
    if (!token) throw new BotsError("signed_out");
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
        signal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new BotsError("failed");
    }
    if (response.status === 401) throw new BotsError("signed_out");
    if (response.status === 400) throw new BotsError("invalid");
    if (!response.ok) throw new BotsError("failed");
    return response;
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new BotsError("failed");
    }
  }

  return {
    async getBotsStatus(signal) {
      if (!getToken()) return { enabled: false };
      const payload = await readJson(await request("GET", "/api/bots/status", signal));
      return { enabled: fields(payload).enabled === true };
    },

    async listMainMessages(signal) {
      return toMessages(await readJson(await request("GET", "/api/bots/main/messages", signal)));
    },

    async getMainWeb(signal) {
      return toWebSettings(await readJson(await request("GET", "/api/bots/main/web", signal)));
    },

    async setMainWeb({ mode, hosts }, signal) {
      return toWebSettings(await readJson(await request("PUT", "/api/bots/main/web", signal, JSON.stringify({ mode, hosts }))));
    },

    async sendToMain(text, onEvent, signal) {
      const response = await request("POST", "/api/bots/main/messages", signal, JSON.stringify({ text }));
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
  };
}

// Same backend origin and session store that App.tsx gives the chat (see lib/signatureClient.ts).
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const SESSION_STORE_KEY = "xyz.tinycloud.tinychat:session";

export const botsApi: BotsApi = createBotsApi({
  baseUrl: BACKEND_URL,
  getToken: () => new SessionStore(SESSION_STORE_KEY).getToken(),
});

export const { getBotsStatus, listMainMessages, getMainWeb, setMainWeb, sendToMain } = botsApi;
