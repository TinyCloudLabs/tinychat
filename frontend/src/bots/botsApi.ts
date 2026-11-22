// Client for the tiny bots routes (TC-2808, docs/plans/tiny-bots-slice1.md): the backend proxies them
// to the bots service with the owner taken from the session, so these calls carry only the session bearer.
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import type { BotsErrorCode } from "./botsStrings";

export interface BotMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  at: string;
  /** Set by the service on a message the app sent for the owner (a decision on a request card), not typed by the owner. */
  origin?: "app";
  /** On an app message: what the owner decided. */
  decision?: AppDecision;
  /** On an app message about a secret request: what the owner's chat line names. */
  secret?: SecretLine;
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

/** The service answered 404: the route is not deployed there. For the owner it is a plain failure, like any other. */
export class BotsRouteMissing extends BotsError {
  constructor() {
    super("failed");
    this.name = "BotsRouteMissing";
  }
}

/** The service answered 409 `no_reply` to an app reply: nothing was left to send for that request. Not a failure to show. */
export class BotsNoReply extends BotsError {
  constructor() {
    super("failed");
    this.name = "BotsNoReply";
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

export type AskState = "pending" | "answered" | "declined" | "stopped" | "expired";

/** What the owner decided, as the service marks the app's message about it. */
export type AppDecision = "answered" | "declined" | "stopped" | "approved" | "revoked";

/** A secret request names a secret, never carries its value. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRET_SITES = 3;
const SITE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** What a chat line about a secret request names: the secret, its sites, the service for a known one, and an approval's end. */
export interface SecretLine {
  name: string;
  sites: string[];
  service?: string;
  until?: string;
}

export type SecretState = "pending" | "approved" | "declined" | "stopped" | "revoked" | "expired" | "ended" | "failed";

/** One secret Main asked to use. A name, the sites it may be used with and what was decided; never a value. */
export interface SecretRequest extends SecretLine {
  id: string;
  kind: "secret";
  state: SecretState;
  askedAt: string;
  expiresAt: string;
  /** Main's one sentence on what it is for, while pending. */
  why?: string;
  /** The OpenKey page where the owner approves it; set once the service has one. */
  approveUrl?: string;
  /** The write methods Main may use it with (a known secret only); absent when it can only read. */
  writes?: string[];
  outside: boolean;
  undelivered: boolean;
  resolvedAt?: string;
}

export type MainRequest = AskRequest | SecretRequest;

/** One question Main asked the owner. The service keeps `question` and `choices` only while pending. */
export interface AskRequest {
  id: string;
  kind: "ask";
  state: AskState;
  askedAt: string;
  expiresAt: string;
  question?: string;
  choices?: string[];
  /** True when Main read something from outside the chat in the turn that asked. */
  outside: boolean;
  /** True while the owner's decision has not yet reached Main. */
  undelivered: boolean;
  resolvedAt?: string;
}

export type AskDecision = { decision: "decline" } | { decision: "answer"; answer: string } | { decision: "answer"; choice: number };

/** Decline a pending secret request, stop an approved one, try a failed one again. */
export type SecretDecision = { decision: "decline" } | { decision: "stop" } | { decision: "retry" };

/** Asks the app sends to Main for the owner's decision on a request; the service composes the words. */
export interface SendOptions {
  appReply?: { requestId: string };
}

export interface BotsApi {
  getBotsStatus(signal?: AbortSignal): Promise<{ enabled: boolean }>;
  listMainMessages(signal?: AbortSignal): Promise<BotMessage[]>;
  getMainWeb(signal?: AbortSignal): Promise<MainWebSettings>;
  /** Resolves with the stored setting; throws BotsError("invalid") when the service refuses the list. */
  setMainWeb(settings: Pick<MainWebSettings, "mode" | "hosts">, signal?: AbortSignal): Promise<MainWebSettings>;
  /** Whether Main may ask the owner things; the service answers 404 when it has no such route. */
  getAsks(signal?: AbortSignal): Promise<{ enabled: boolean }>;
  setAsks(settings: { enabled: boolean }, signal?: AbortSignal): Promise<{ enabled: boolean }>;
  /** Pending requests first, then recent resolved ones: questions and secret requests. */
  listRequests(signal?: AbortSignal): Promise<MainRequest[]>;
  /** Records the owner's decision; throws when the request can no longer take it. */
  answerRequest(id: string, decision: AskDecision | SecretDecision, signal?: AbortSignal): Promise<MainRequest>;
  /**
   * Resolves after the stream's `done` or `error` event; throws BotsError when the stream fails or ends without one.
   * With `options.appReply` the message is the app's report of the owner's decision on that request: no text goes
   * with it (the service composes it), and `text` is ignored.
   */
  sendToMain(text: string, onEvent: (event: MainEvent) => void, signal?: AbortSignal, options?: SendOptions): Promise<void>;
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
    if (typeof value.id !== "string" || (value.role !== "user" && value.role !== "bot") || typeof value.text !== "string") return [];
    const app = value.origin === "app";
    const secret = app ? toSecretLine(value.secret) : undefined;
    return [{
      id: value.id, role: value.role, text: value.text, at: typeof value.at === "string" ? value.at : "",
      ...(app ? { origin: "app" as const } : {}),
      ...(app && isAppDecision(value.decision) ? { decision: value.decision } : {}),
      ...(secret ? { secret } : {}),
    }];
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

const isoTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

const APP_DECISIONS: readonly unknown[] = ["answered", "declined", "stopped", "approved", "revoked"] satisfies AppDecision[];
export const isAppDecision = (value: unknown): value is AppDecision => APP_DECISIONS.includes(value);

const SECRET_STATES: readonly unknown[] = ["pending", "approved", "declined", "stopped", "revoked", "expired", "ended", "failed"] satisfies SecretState[];
const isSites = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length >= 1 && value.length <= MAX_SECRET_SITES && value.every(site => typeof site === "string" && SITE_NAME.test(site));

const WRITE_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];
const isWrites = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length >= 1 && value.length <= WRITE_METHODS.length && value.every(method => typeof method === "string" && WRITE_METHODS.includes(method));

/** A secret line from the service or the history: a valid name and sites, or nothing. */
export function toSecretLine(payload: unknown): SecretLine | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { name, sites, service, until } = fields(payload);
  if (typeof name !== "string" || !SECRET_NAME.test(name) || !isSites(sites)) return undefined;
  return {
    name, sites: [...sites],
    ...(typeof service === "string" && service.length > 0 && service.length <= 60 ? { service } : {}),
    ...(isoTime(until) ? { until } : {}),
  };
}

function toRequest(payload: unknown): MainRequest {
  const value = fields(payload);
  const { id, kind, state, askedAt, expiresAt, question, choices, answer, outside, resolvedAt } = value;
  if (typeof id !== "string" || id.length === 0 || id.length > 64 || !isoTime(askedAt) || !isoTime(expiresAt)) throw new BotsError("failed");
  const common = {
    id, askedAt, expiresAt,
    outside: outside === true,
    undelivered: value.undelivered === true || typeof answer === "string",
    ...(isoTime(resolvedAt) ? { resolvedAt } : {}),
  };
  if (kind === "secret") {
    const line = toSecretLine(value);
    if (!line || !SECRET_STATES.includes(state)) throw new BotsError("failed");
    const { why, approveUrl, writes } = value;
    return {
      ...common, ...line, kind, state: state as SecretState,
      ...(typeof why === "string" ? { why } : {}),
      ...(typeof approveUrl === "string" && approveUrl.length <= 2048 && approveUrl.startsWith("https://") ? { approveUrl } : {}),
      ...(isWrites(writes) ? { writes: [...writes] } : {}),
    };
  }
  if (kind !== "ask" || (state !== "pending" && state !== "answered" && state !== "declined" && state !== "stopped" && state !== "expired")) {
    throw new BotsError("failed");
  }
  return {
    ...common, kind, state,
    ...(typeof question === "string" ? { question } : {}),
    ...(Array.isArray(choices) ? { choices: choices.filter((choice): choice is string => typeof choice === "string") } : {}),
  };
}

function toRequests(payload: unknown): MainRequest[] {
  const list = fields(payload).requests;
  if (!Array.isArray(list)) throw new BotsError("failed");
  return list.flatMap((item: unknown) => { try { return [toRequest(item)]; } catch { return []; } });
}

function toAsks(payload: unknown): { enabled: boolean } {
  const { enabled } = fields(payload);
  if (typeof enabled !== "boolean") throw new BotsError("failed");
  return { enabled };
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
    if (response.status === 404) throw new BotsRouteMissing();
    // The service refuses an app reply for a request that has nothing to deliver (already sent, or not decided).
    if (response.status === 409 && fields(await response.json().catch(() => null)).error === "no_reply") throw new BotsNoReply();
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

    async getAsks(signal) {
      return toAsks(await readJson(await request("GET", "/api/bots/main/asks", signal)));
    },

    async setAsks({ enabled }, signal) {
      return toAsks(await readJson(await request("PUT", "/api/bots/main/asks", signal, JSON.stringify({ enabled }))));
    },

    async listRequests(signal) {
      return toRequests(await readJson(await request("GET", "/api/bots/main/requests", signal)));
    },

    async answerRequest(id, decision, signal) {
      const path = `/api/bots/main/requests/${encodeURIComponent(id)}/answer`;
      return toRequest(await readJson(await request("POST", path, signal, JSON.stringify(decision))));
    },

    async sendToMain(text, onEvent, signal, options) {
      const body = options?.appReply ? { appReply: { requestId: options.appReply.requestId } } : { text };
      const response = await request("POST", "/api/bots/main/messages", signal, JSON.stringify(body));
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

export const { getBotsStatus, listMainMessages, getMainWeb, setMainWeb, getAsks, setAsks, listRequests, answerRequest, sendToMain } = botsApi;
