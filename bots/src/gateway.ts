// Egress gateway: the only way a bot sandbox reaches anything. Runs in its own unprivileged container and is the
// only process holding the model key. Each bot gets one Unix socket; a request is forwarded only when it carries
// that bot's own token, hits one of two routes, names an allowed model, and fits the budgets. The request body is
// rebuilt from an allowlist, so nothing the bot adds reaches the upstream, and the upstream origin is fixed.
// A bot holds at most one request slot at a time, taken before its body is read, so it cannot pile up bodies.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { GatewayConfig } from "./config";
import { isRecord } from "./guards";
import { bearerMatches } from "./owner";

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
/** Conservative bytes-per-token for estimating a prompt before the upstream reports usage. */
const BYTES_PER_TOKEN = 3;
const ROLES: Record<string, true> = { system: true, developer: true, user: true, assistant: true, tool: true };
const TOOL_CHOICES: Record<string, true> = { auto: true, none: true, required: true };

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

function failure(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

/** Message content as text only: a string, null, or text parts (images, cache hints and the rest are dropped). */
function textContent(content: unknown): string | null | Array<{ type: "text"; text: string }> | undefined {
  if (typeof content === "string" || content === null) return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(part =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [{ type: "text" as const, text: part.text }] : [],
  );
}

function chatMessage(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || typeof input.role !== "string" || !ROLES[input.role]) return null;
  const content = textContent(input.content);
  if (content === undefined) return null;
  const message: Record<string, unknown> = { role: input.role, content };
  if (input.role === "assistant" && Array.isArray(input.tool_calls)) {
    const calls = input.tool_calls.map(call =>
      isRecord(call) && typeof call.id === "string" && isRecord(call.function) && typeof call.function.name === "string" &&
      typeof call.function.arguments === "string"
        ? { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }
        : null,
    );
    if (calls.includes(null)) return null;
    message.tool_calls = calls;
  }
  if (input.role === "tool") {
    if (typeof input.tool_call_id !== "string") return null;
    message.tool_call_id = input.tool_call_id;
  }
  return message;
}

function tool(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || input.type !== "function" || !isRecord(input.function) || typeof input.function.name !== "string") {
    return null;
  }
  const { name, description, parameters } = input.function;
  return {
    type: "function",
    function: {
      name,
      ...(typeof description === "string" ? { description } : {}),
      ...(isRecord(parameters) ? { parameters } : {}),
    },
  };
}

/**
 * The upstream chat body, rebuilt from the bot's request: only these fields survive (messages and tools rebuilt
 * field by field), the model must be allowed, max_tokens is capped, usage is always reported, and provider
 * routing is set here, never by the bot.
 */
export function chatBody(input: unknown, cfg: Pick<GatewayConfig, "models" | "maxTokens">): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  if (!Array.isArray(input.messages) || input.messages.length === 0) return null;
  if (typeof input.model !== "string" || !cfg.models.includes(input.model)) return null;
  const messages = input.messages.map(chatMessage);
  if (messages.includes(null)) return null;
  const body: Record<string, unknown> = { model: input.model, messages };
  if (input.stream === true) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (Array.isArray(input.tools)) {
    const tools = input.tools.map(tool);
    if (tools.includes(null)) return null;
    body.tools = tools;
  }
  if (typeof input.tool_choice === "string" && TOOL_CHOICES[input.tool_choice]) body.tool_choice = input.tool_choice;
  if (isRecord(input.tool_choice) && isRecord(input.tool_choice.function) && typeof input.tool_choice.function.name === "string") {
    body.tool_choice = { type: "function", function: { name: input.tool_choice.function.name } };
  }
  if (typeof input.temperature === "number" && Number.isFinite(input.temperature)) body.temperature = input.temperature;
  if (typeof input.stop === "string" || (Array.isArray(input.stop) && input.stop.every(stop => typeof stop === "string"))) {
    body.stop = input.stop;
  }
  // OpenAI-compatible clients send either name; the upstream gets max_tokens, never above the cap.
  const requested = [input.max_tokens, input.max_completion_tokens].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 1,
  );
  body.max_tokens = Math.min(Math.floor(requested ?? cfg.maxTokens), cfg.maxTokens);
  body.provider = { aci_verified: true, allow_fallbacks: false };
  return body;
}

/** Reads usage from an OpenAI-compatible response: the last `data:` event when streaming, else the whole body. */
class UsageReader {
  readonly #decoder = new TextDecoder();
  #text = "";
  tokens: number | undefined;

  constructor(readonly streaming: boolean) {}

  push(chunk: Uint8Array): void {
    this.#text += this.#decoder.decode(chunk, { stream: true });
    if (this.streaming) this.#scanLines();
  }

  end(): void {
    this.#text += this.#decoder.decode();
    if (!this.streaming) {
      this.#read(this.#text);
      return;
    }
    this.#text += "\n";
    this.#scanLines();
  }

  #scanLines(): void {
    let newline = this.#text.indexOf("\n");
    while (newline !== -1) {
      const line = this.#text.slice(0, newline).trim();
      this.#text = this.#text.slice(newline + 1);
      if (line.startsWith("data:")) this.#read(line.slice("data:".length).trim());
      newline = this.#text.indexOf("\n");
    }
  }

  #read(json: string): void {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return;
    }
    if (!isRecord(value) || !isRecord(value.usage)) return;
    const { total_tokens: total, prompt_tokens: prompt, completion_tokens: completion } = value.usage;
    const count = typeof total === "number" ? total : Number(prompt ?? 0) + Number(completion ?? 0);
    if (Number.isFinite(count) && count >= 0) this.tokens = count;
  }
}

interface UpstreamCall {
  response: Response;
  /** Clears the total deadline once the response is fully relayed. */
  done: () => void;
  abort: () => void;
  /** Aborts at the total deadline (or on abort()). */
  signal: AbortSignal;
}

async function readCapped(response: Response, cap: number): Promise<string | null> {
  const bytes = await response.arrayBuffer();
  return bytes.byteLength > cap ? null : new TextDecoder().decode(bytes);
}

/** Reads a request body as it arrives, stopping at `cap` bytes or `timeoutMs`, whichever comes first. */
async function readBody(req: Request, cap: number, timeoutMs: number): Promise<Uint8Array | "too_large" | "timeout"> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => deadline.resolve("timeout"), timeoutMs);
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline.promise]);
      if (next === "timeout") return "timeout";
      if (next.done) break;
      size += next.value.byteLength;
      if (size > cap) return "too_large";
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Today's counted tokens, per bot and in total (UTC day). */
export interface BudgetSnapshot {
  day: string;
  total: number;
  perBot: Record<string, number>;
}

export interface BudgetStore {
  load(): BudgetSnapshot | undefined;
  save(snapshot: BudgetSnapshot): void;
}

/**
 * Budget counters on the gateway's own volume, so a restart (or a crash a bot provokes) cannot reset them. A file
 * that exists but cannot be read stops the gateway from starting: it fails closed rather than starting from zero.
 */
export function fileBudgetStore(path: string): BudgetStore {
  return {
    load() {
      if (!existsSync(path)) return undefined;
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      const valid =
        isRecord(value) && typeof value.day === "string" && typeof value.total === "number" && isRecord(value.perBot) &&
        Object.values(value.perBot).every(tokens => typeof tokens === "number");
      if (!valid) throw new Error(`budget file ${path} is malformed; refusing to start with reset budgets`);
      return value as unknown as BudgetSnapshot;
    },
    save(snapshot) {
      writeFileSync(`${path}.new`, JSON.stringify(snapshot));
      renameSync(`${path}.new`, path);
    },
  };
}

export interface GatewayDeps {
  fetch?: UpstreamFetch;
  now?: () => number;
  store?: BudgetStore;
}

export class Gateway {
  readonly #cfg: GatewayConfig;
  readonly #fetch: UpstreamFetch;
  readonly #now: () => number;
  readonly #store: BudgetStore | undefined;
  readonly #tokens = new Map<string, string>();
  readonly #inflight = new Set<string>();
  readonly #used = new Map<string, number>();
  #usedTotal = 0;
  #day = "";

  constructor(cfg: GatewayConfig, deps: GatewayDeps = {}) {
    this.#cfg = cfg;
    this.#fetch = deps.fetch ?? fetch;
    this.#now = deps.now ?? Date.now;
    this.#store = deps.store;
    const saved = this.#store?.load();
    if (saved) {
      this.#day = saved.day;
      this.#usedTotal = saved.total;
      for (const [botId, tokens] of Object.entries(saved.perBot)) this.#used.set(botId, tokens);
    }
  }

  setToken(botId: string, token: string): void {
    this.#tokens.set(botId, token);
  }

  dropToken(botId: string): void {
    this.#tokens.delete(botId);
  }

  /**
   * Handles one request that arrived on `botId`'s socket. `streaming` is called once the request is accepted and
   * its body read, just before the response may run long (the server lifts its idle timeout there).
   */
  async handle(botId: string, req: Request, streaming: () => void = () => {}): Promise<Response> {
    const path = new URL(req.url).pathname;
    const route = `${req.method} ${path}`.slice(0, 120);
    const token = this.#tokens.get(botId);
    if (!token || !bearerMatches(req.headers.get("authorization"), token)) return this.#deny(botId, "token", 403, route);
    if (req.method === "GET" && path === MODELS_PATH) return this.#models(botId);
    if (req.method === "POST" && path === CHAT_PATH) return this.#chat(botId, req, streaming);
    return this.#deny(botId, "route", 403, route);
  }

  /** Tokens counted today for one bot, and for all bots. */
  usage(botId: string): { bot: number; total: number } {
    this.#rollDay();
    return { bot: this.#used.get(botId) ?? 0, total: this.#usedTotal };
  }

  #remaining(botId: string): number {
    const used = this.usage(botId);
    return Math.min(this.#cfg.botDailyTokens - used.bot, this.#cfg.globalDailyTokens - used.total);
  }

  #deny(botId: string, reason: string, status: number, route?: string): Response {
    console.log(JSON.stringify({ gateway: "deny", bot: botId.slice(0, 12), reason, route }));
    return failure(status, "Request refused by the bots gateway.");
  }

  #rollDay(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day === this.#day) return;
    this.#day = day;
    this.#used.clear();
    this.#usedTotal = 0;
  }

  #charge(botId: string, tokens: number): void {
    this.#rollDay();
    this.#used.set(botId, (this.#used.get(botId) ?? 0) + tokens);
    this.#usedTotal += tokens;
    try {
      this.#store?.save({ day: this.#day, total: this.#usedTotal, perBot: Object.fromEntries(this.#used) });
    } catch (error) {
      console.log(JSON.stringify({ gateway: "budget_save_failed", error: error instanceof Error ? error.message : "unknown" }));
    }
  }

  /** fetch against the pinned origin with connect and total deadlines; redirects are refused. */
  async #upstream(path: string, init: RequestInit): Promise<UpstreamCall> {
    const controller = new AbortController();
    const total = setTimeout(() => controller.abort(), this.#cfg.totalTimeoutMs);
    const connect = setTimeout(() => controller.abort(), this.#cfg.connectTimeoutMs);
    const done = () => clearTimeout(total);
    try {
      const response = await this.#fetch(`${this.#cfg.upstream}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.#cfg.modelKey}`, "content-type": "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      return { response, done, abort: () => controller.abort(), signal: controller.signal };
    } catch (error) {
      done();
      throw error;
    } finally {
      clearTimeout(connect);
    }
  }

  async #models(botId: string): Promise<Response> {
    let upstream: UpstreamCall;
    try {
      upstream = await this.#upstream(MODELS_PATH, { method: "GET" });
    } catch {
      return failure(502, "Model list unavailable.");
    }
    try {
      const text = upstream.response.ok ? await readCapped(upstream.response, this.#cfg.maxResponseBytes) : null;
      const parsed: unknown = text === null ? null : JSON.parse(text);
      if (!isRecord(parsed) || !Array.isArray(parsed.data)) return failure(502, "Model list unavailable.");
      const data = parsed.data.filter(model => isRecord(model) && typeof model.id === "string" && this.#cfg.models.includes(model.id));
      console.log(JSON.stringify({ gateway: "allow", bot: botId.slice(0, 12), route: `GET ${MODELS_PATH}` }));
      return Response.json({ object: "list", data });
    } catch {
      return failure(502, "Model list unavailable.");
    } finally {
      upstream.done();
    }
  }

  async #chat(botId: string, req: Request, streaming: () => void): Promise<Response> {
    // Everything that can refuse without reading the body comes first: size header, budget, the bot's one slot.
    if (Number(req.headers.get("content-length") ?? 0) > this.#cfg.maxBodyBytes) return this.#deny(botId, "body_size", 413);
    if (this.#remaining(botId) <= 0) return this.#deny(botId, "budget", 429);
    if (this.#inflight.has(botId)) return this.#deny(botId, "concurrency", 429);
    this.#inflight.add(botId);
    let relaying = false;
    try {
      const raw = await readBody(req, this.#cfg.maxBodyBytes, this.#cfg.bodyTimeoutMs);
      if (raw === "too_large") return this.#deny(botId, "body_size", 413);
      if (raw === "timeout") return this.#deny(botId, "body_timeout", 408);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return this.#deny(botId, "body", 400);
      }
      const body = chatBody(parsed, this.#cfg);
      if (!body) return this.#deny(botId, "body", 400);
      // Never let one request overshoot the budget: the prompt must fit, and the output is capped to what is left.
      const estimate = Math.ceil(raw.byteLength / BYTES_PER_TOKEN);
      const remaining = this.#remaining(botId);
      if (estimate >= remaining) return this.#deny(botId, "budget", 429);
      body.max_tokens = Math.min(body.max_tokens as number, remaining - estimate);
      // Charged when no usage arrives (the stream was cut short): the prompt estimate plus the output cap.
      const fallbackTokens = estimate + (body.max_tokens as number);

      streaming();
      let upstream: UpstreamCall;
      try {
        upstream = await this.#upstream(CHAT_PATH, { method: "POST", body: JSON.stringify(body) });
      } catch {
        return failure(502, "Model unavailable.");
      }
      relaying = true;
      return this.#relay(botId, upstream, body.stream === true, fallbackTokens);
    } finally {
      if (!relaying) this.#inflight.delete(botId);
    }
  }

  /** Streams the upstream response back, counting bytes and usage; releases the bot's slot when it ends. */
  #relay(botId: string, upstream: UpstreamCall, streamed: boolean, fallbackTokens: number): Response {
    const { response, done, abort } = upstream;
    const usage = new UsageReader(streamed);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done();
      this.#inflight.delete(botId);
      const tokens = usage.tokens ?? (response.ok ? fallbackTokens : 0);
      this.#charge(botId, tokens);
      console.log(JSON.stringify({ gateway: "allow", bot: botId.slice(0, 12), route: `POST ${CHAT_PATH}`, status: response.status, tokens }));
    };
    // A reader that stops pulling must not hold the bot's slot past the deadline.
    upstream.signal.addEventListener("abort", finish, { once: true });
    const reader = response.body?.getReader();
    if (!reader) {
      finish();
      return new Response(null, { status: response.status });
    }
    let bytes = 0;
    const relay = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const { done: ended, value } = await reader.read();
          if (ended) {
            usage.end();
            finish();
            controller.close();
            return;
          }
          bytes += value.byteLength;
          if (bytes > this.#cfg.maxResponseBytes) {
            abort();
            finish();
            controller.error(new Error("response too large"));
            return;
          }
          usage.push(value);
          controller.enqueue(value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      cancel: () => {
        abort();
        finish();
      },
    });
    return new Response(relay, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  }
}
