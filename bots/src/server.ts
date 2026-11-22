// Internal HTTP API, called only by the TinyChat backend (docs/plans/tiny-bots-slice1.md, piece 1).
// Every SSE event is encoded here from checked fields; nothing from a sandbox is passed through raw.

import type { ActivityRecord, StagedHistory } from "./history";
import type { BotAdmission } from "./bot-admission";
import { type AsksSettings, type BotMessenger, type ErrorCode, ERROR_MESSAGES, type ListedMessage, MAX_TEXT, type TurnSink, type WebSettings } from "./bot";
import { INVALID_HOSTS, parseWebPolicy, type WebPolicy } from "./web-policy";
import { type AnswerInput, type AnswerResult, type AppOrigin, type AskReply, type AskRequest, parseAnswerInput } from "./asks";
import { isRecord } from "./guards";
import { ANNOUNCED_STATES, type AnnouncedState, type BotState, OwnerBotLimit } from "./manifest";
import { legacyOwnerHeaderAccepted } from "./config";
import { MESSAGING_STRINGS } from "./messaging-strings";
import { authorizedOwner, isBotKey, MAIN_KEY, ownerAllowed } from "./owner";
import type { DeleteSkip } from "./retention";
import type { HostToolReply } from "./rpc";
import { type Environment, NonceGuard, SIGNED_SCHEME, verifyCall } from "./signed-call";

/** `/v1/bots/<key>` and what follows it. The key is checked before anything is built from it. */
const BOT_PATH = /^\/v1\/bots\/([^/]+)(\/.*)?$/;
const REQUEST_ID = /^[0-9a-f]{1,64}$/;
const ANSWER_PATH = /^\/requests\/([0-9a-f]{1,64})\/answer$/;

/** What a request does to a bot, which decides the states it is allowed in. */
type Operation = "turn" | "read" | "history";
const ALLOWED: Record<Operation, readonly BotState[]> = {
  turn: ["active"],
  read: ["active", "suspended"],
  // Saving history, its notice and its permission go on for a bot that is suspended or being deleted: a deletion
  // waits for exactly these.
  history: ["active", "suspended", "deleting"],
};

function operationOf(rest: string, method: string): Operation | undefined {
  if (rest === "/web" || rest === "/asks" || rest === "/requests" || ANSWER_PATH.test(rest)) return "read";
  if (rest === "/messages") return method === "POST" ? "turn" : "read";
  if (rest === "/history" || rest === "/history/stage" || rest === "/history/permission" || rest === "/history/notice") return "history";
  return undefined;
}

export interface BotApi {
  /** `from` says who wrote the text; only the owner's own messages teach the bot which addresses it may read. An `AppOrigin` is only ever this service's own composed reply. */
  send(text: string, sink: TurnSink, owner?: string, messenger?: BotMessenger, from?: "owner" | "bot" | AppOrigin): Promise<void>;
  list(): Promise<ListedMessage[]>;
  listActivities?(): Promise<ActivityRecord[]>;
  historyPending?(): Promise<unknown>;
  historyStage?(staged: StagedHistory): Promise<void>;
  historyPermission?(owner: string, expiresAt?: number, validUntil?: number): Promise<void>;
  historyNotice?(): Promise<unknown>;
  historyNoticeAck?(id: string, receivedAt: number): Promise<void>;
  historyReceipt?(receipt: unknown): Promise<void>;
  webSettings?(): Promise<WebSettings>;
  setWebPolicy?(policy: WebPolicy): Promise<WebSettings>;
  /** The owner's setting for questions from Main, and their requests. Absent: the service does not have them (404). */
  asksSettings?(): Promise<AsksSettings>;
  setAsksEnabled?(enabled: boolean): Promise<AsksSettings>;
  requests?(): Promise<AskRequest[]>;
  answerRequest?(id: string, input: AnswerInput): Promise<AnswerResult>;
  /** The message for Main that tells it what the owner decided; undefined unless decided and not yet delivered. */
  appReply?(requestId: string): AskReply | undefined;
  appReplyDelivered?(requestId: string): void;
}

export interface AppOptions {
  /** This service's secret. */
  secret: string;
  accounts: Set<string> | "*";
  admit?: BotAdmission;
  /** The environment this service runs. Default `private`. */
  environment?: Environment;
  /** Unset: from BOTS_ACCEPT_LEGACY_OWNER_HEADER. */
  acceptLegacyOwnerHeader?: boolean;
  bots: {
    forOwner(ownerDid: string): BotApi;
    /** A sibling by key. Without it the service has only Main. */
    forBot?(ownerDid: string, key: string): BotApi;
    deleteBot?(ownerDid: string, key: string): Promise<DeleteSkip | undefined>;
  };
  /** Which siblings the backend has announced. Without it the service has only Main, always active. */
  manifest?: {
    stateOf(ownerDid: string, key: string): BotState | undefined;
    announce(ownerDid: string, key: string, state: AnnouncedState, seq: number): BotState;
    markRemoved(ownerDid: string, key: string): void;
  };
}

const encoder = new TextEncoder();
/** Bytes an SSE stream may queue for a caller that is not reading; past it the stream is dropped, not buffered. */
const MAX_QUEUED_BYTES = 1024 * 1024;
// Keeps one tool reply well below the RPC frame limit even when JSON escapes its characters.
const MAX_BOT_REPLY_BYTES = 32 * 1024;
const UNAVAILABLE_REPLY = { text: MESSAGING_STRINGS.unavailable, isError: true } as const;

async function relayMessage(target: BotApi, owner: string, text: string): Promise<HostToolReply> {
  let reply = "";
  let bytes = 0;
  let complete = false;
  let errorCode: ErrorCode | undefined;
  // A delivered message always starts a turn with no messenger, even if this bot previously had one.
  await target.send(text, {
    status() {},
    delta(chunk) {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_BOT_REPLY_BYTES) reply += chunk;
    },
    done: () => { complete = true; },
    error: code => { errorCode = code; },
  }, owner, undefined, "bot");
  if (errorCode === "busy") return { text: MESSAGING_STRINGS.busy, isError: true };
  if (errorCode || !complete || !reply || bytes > MAX_BOT_REPLY_BYTES) return UNAVAILABLE_REPLY;
  return { text: reply };
}

function turnMessenger(options: AppOptions, owner: string, sourceKey: string, value: unknown): BotMessenger | undefined {
  const { admit, manifest } = options;
  if (!admit || !manifest || !Array.isArray(value)
    || !value.every((key): key is string => typeof key === "string" && isBotKey(key))) return undefined;
  const keys = [...new Set(value)].filter(key => key !== sourceKey);
  if (!keys.length) return undefined;
  return {
    keys,
    async dispatch(targetKey, text, signal) {
      if (!keys.includes(targetKey) || signal.aborted) return UNAVAILABLE_REPLY;
      try {
        // The backend checks current ownership, state and environment for every delivery, even if the manifest is stale.
        const decision = await admit(owner, sourceKey, targetKey);
        if (signal.aborted || decision.admitted !== true || manifest.stateOf(owner, sourceKey) !== "active"
          || manifest.stateOf(owner, targetKey) !== "active") return UNAVAILABLE_REPLY;
        const target = targetKey === MAIN_KEY ? options.bots.forOwner(owner) : options.bots.forBot?.(owner, targetKey);
        return target ? await relayMessage(target, owner, text) : UNAVAILABLE_REPLY;
      } catch {
        return UNAVAILABLE_REPLY;
      }
    },
  };
}

function eventStream(run: (sink: TurnSink) => Promise<void>): Response {
  let open = true;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const send = (event: string, data: Record<string, string | number>) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            // desiredSize goes negative by the bytes waiting beyond the high-water mark.
            if ((controller.desiredSize ?? 0) < -MAX_QUEUED_BYTES) {
              open = false;
              controller.error(new Error("caller is not reading"));
            }
          } catch {
            open = false;
          }
        };
        const sink: TurnSink = {
          status: state => send("status", { state }),
          delta: text => send("delta", { text }),
          activity: record => {
            const { type, id, verb, count, at } = record;
            send("activity", { type, id, verb, count, at, ...(verb === "messaged_bot" ? { targetKey: record.targetKey } : {}) });
          },
          done: messageId => send("done", { messageId }),
          error: (code: ErrorCode) => send("error", { code, message: ERROR_MESSAGES[code] }),
        };
        // The turn keeps running if the caller goes away; its reply still lands in the session.
        void run(sink)
          .catch(() => sink.error("bot_unavailable"))
          .finally(() => {
            if (!open) return;
            open = false;
            controller.close();
          });
      },
      cancel() {
        open = false;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
  );
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

/** `PUT /v1/bots/<key>`: the backend announces a bot's state. The answer is the state now held, which may be an older or final one. */
async function announce(req: Request, manifest: NonNullable<AppOptions["manifest"]>, owner: string, key: string): Promise<Response> {
  const body: unknown = await req.json().catch(() => null);
  const state = isRecord(body) ? ANNOUNCED_STATES.find(known => known === body.state) : undefined;
  const seq = isRecord(body) ? body.seq : undefined;
  if (!state || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || (key === MAIN_KEY && state === "deleting")) {
    return new Response(null, { status: 400 });
  }
  try {
    return Response.json({ state: manifest.announce(owner, key, state, seq) });
  } catch (error) {
    // This service's own limit on one owner's bots. Anything else is not expected here and is not hidden.
    if (error instanceof OwnerBotLimit) return Response.json({ error: "owner_bot_limit" }, { status: 409 });
    throw error;
  }
}

/** `DELETE /v1/bots/<key>`: gone, waiting (it will go once its history is saved) or failed. Only a bot being deleted may go. */
async function remove(options: AppOptions, owner: string, key: string): Promise<Response> {
  const state = options.manifest!.stateOf(owner, key);
  if (state === "removed") return Response.json({ outcome: "gone" });
  if (state !== "deleting" || !options.bots.deleteBot) return new Response(null, { status: state ? 409 : 404 });
  const cause = await options.bots.deleteBot(owner, key);
  if (cause === undefined) {
    options.manifest!.markRemoved(owner, key);
    return Response.json({ outcome: "gone" });
  }
  const waiting = cause === "archive_pending" || cause === "closing" || cause === "gateway_cleanup_pending";
  return Response.json({ outcome: waiting ? "waiting" : "failed", cause });
}

export function createApp(options: AppOptions): (req: Request) => Promise<Response> {
  const environment = options.environment ?? "private";
  const acceptLegacy = options.acceptLegacyOwnerHeader ?? legacyOwnerHeaderAccepted(process.env);
  const nonces = new NonceGuard();
  return async incoming => {
    const url = new URL(incoming.url);
    const path = url.pathname;
    if (incoming.method === "GET" && path === "/healthz") return new Response("ok");
    const match = BOT_PATH.exec(path);
    const authorization = incoming.headers.get("authorization");
    let owner: string | null = null;
    let req = incoming;
    const signed = authorization?.startsWith(SIGNED_SCHEME) === true;
    if (signed) {
      // The body is read once to check its hash, then passed on.
      const body = new Uint8Array(await incoming.arrayBuffer().catch(() => new ArrayBuffer(0)));
      const claims = verifyCall(authorization, { method: incoming.method, path: path + url.search, body }, { secret: options.secret, direction: "to-service", environment, nonces });
      if (claims && claims.bot === match?.[1] && ownerAllowed(claims.owner, options.accounts)) {
        owner = claims.owner;
        req = new Request(incoming.url, { method: incoming.method, headers: incoming.headers, body: body.byteLength > 0 ? body : undefined });
      }
    } else if (acceptLegacy) {
      owner = authorizedOwner(incoming, options.secret, options.accounts);
    }
    if (!owner) return new Response(null, { status: 401 });
    if (!match || !isBotKey(match[1]!)) return new Response(null, { status: 404 });
    const key = match[1]!;
    const rest = match[2] ?? "";
    if (rest === "") {
      if (!options.manifest) return new Response(null, { status: 404 });
      try {
        if (req.method === "PUT") return await announce(req, options.manifest, owner, key);
        if (req.method === "DELETE" && key !== MAIN_KEY) return await remove(options, owner, key);
      } catch { return new Response(null, { status: 503 }); }
      return new Response(null, { status: 405 });
    }
    if ((rest === "/web" || rest === "/asks" || rest === "/requests" || ANSWER_PATH.test(rest)) && key !== MAIN_KEY) return new Response(null, { status: 404 });
    const operation = operationOf(rest, req.method);
    if (!operation) return new Response(null, { status: 404 });
    // The state is read before a sibling is looked up, so a key nobody announced never creates anything.
    let state: BotState | undefined;
    try { state = options.manifest ? options.manifest.stateOf(owner, key) : key === MAIN_KEY ? "active" : undefined; }
    catch { return new Response(null, { status: 503 }); }
    if (!state || state === "removed") return new Response(null, { status: 404 });
    if (!ALLOWED[operation].includes(state)) return Response.json({ error: "bot_state", state }, { status: 409 });
    const found = key === MAIN_KEY ? options.bots.forOwner(owner) : options.bots.forBot?.(owner, key);
    if (!found) return new Response(null, { status: 404 });
    const bot = found;
    if (rest === "/web") {
      try {
        if (req.method === "GET" && bot.webSettings) return Response.json(await bot.webSettings());
        if (req.method === "PUT" && bot.setWebPolicy) {
          const policy = parseWebPolicy(await req.json().catch(() => null));
          if (!policy) return Response.json({ error: "invalid", message: INVALID_HOSTS }, { status: 400 });
          return Response.json(await bot.setWebPolicy(policy));
        }
      } catch {
        return Response.json({ error: "bot_unavailable", message: ERROR_MESSAGES.bot_unavailable }, { status: 503 });
      }
      return new Response(null, { status: 405 });
    }
    if (rest === "/asks" || rest === "/requests" || ANSWER_PATH.test(rest)) {
      try {
        if (rest === "/asks" && req.method === "GET" && bot.asksSettings) return Response.json(await bot.asksSettings());
        if (rest === "/asks" && req.method === "PUT" && bot.setAsksEnabled) {
          const input: unknown = await req.json().catch(() => null);
          if (!isRecord(input) || Object.keys(input).length !== 1 || typeof input.enabled !== "boolean") return Response.json({ error: "invalid" }, { status: 400 });
          return Response.json(await bot.setAsksEnabled(input.enabled));
        }
        if (rest === "/requests" && req.method === "GET" && bot.requests) return Response.json({ requests: await bot.requests() });
        if (req.method === "POST" && bot.answerRequest && ANSWER_PATH.test(rest)) {
          const decision = parseAnswerInput(await req.json().catch(() => null));
          if (!decision) return Response.json({ error: "invalid" }, { status: 400 });
          const result = await bot.answerRequest(ANSWER_PATH.exec(rest)![1]!, decision);
          if (result.ok) return Response.json(result.request);
          // One answer for a request that is gone, decided, expired or never existed: no way to tell which.
          return result.error === "invalid" ? Response.json({ error: "invalid" }, { status: 400 }) : Response.json({ error: "not_pending" }, { status: 409 });
        }
      } catch {
        return Response.json({ error: "bot_unavailable", message: ERROR_MESSAGES.bot_unavailable }, { status: 503 });
      }
      // A bot that does not serve questions reads as a service that does not have them.
      return new Response(null, { status: bot.asksSettings ? 405 : 404 });
    }
    if (rest === "/history/stage" && req.method === "POST") {
      try { await bot.historyStage?.(await req.json()); return new Response(null, { status: 204 }); }
      catch { return new Response(null, { status: 503 }); }
    }
    if (rest === "/history/permission" && req.method === "PUT") {
      try {
        const body = await req.json();
        await bot.historyPermission?.(owner, body.expiresAt, body.validUntil);
        return new Response(null, { status: 204 });
      } catch { return new Response(null, { status: 503 }); }
    }
    if (rest === "/history/notice") {
      try {
        if (req.method === "GET") return Response.json({ notice: await bot.historyNotice?.() ?? null });
        if (req.method === "POST") {
          const body = await req.json();
          await bot.historyNoticeAck?.(body.id, body.receivedAt);
          return Response.json({ notice: await bot.historyNotice?.() ?? null });
        }
      } catch { return new Response(null, { status: 503 }); }
    }
    if (rest === "/history") {
      try {
        if (req.method === "GET") return Response.json({ batch: await bot.historyPending?.() ?? null });
        if (req.method === "POST" && bot.historyReceipt) { await bot.historyReceipt(await req.json()); return new Response(null, { status: 204 }); }
      } catch { return Response.json({ error: "history_unavailable" }, { status: 503 }); }
      return new Response(null, { status: 405 });
    }
    if (rest !== "/messages") return new Response(null, { status: 404 });

    if (req.method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const messenger = signed ? turnMessenger(options, owner, key, isRecord(body) ? body.messageableBotKeys : undefined) : undefined;
      if (isRecord(body) && body.appReply !== undefined) {
        // The owner's decision reaches Main as a message this service composes from what it stored. Any text or `from`
        // the caller sent is not read; a request that is not decided, not Main's or already delivered sends nothing.
        const requestId = isRecord(body.appReply) ? body.appReply.requestId : undefined;
        if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return eventStream(async sink => sink.error("invalid"));
        let reply: AskReply | undefined;
        try { reply = bot.appReply?.(requestId); } catch { return new Response(null, { status: 503 }); }
        if (reply === undefined) return Response.json({ error: "no_reply" }, { status: 409 });
        const { text: replyText, decision } = reply;
        return eventStream(sink => bot.send(replyText, {
          ...sink,
          done: messageId => { try { bot.appReplyDelivered?.(requestId); } finally { sink.done(messageId); } },
        }, owner, messenger, { app: decision }));
      }
      const text = isRecord(body) ? body.text : undefined;
      if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
        return eventStream(async sink => sink.error("invalid"));
      }
      return eventStream(sink => bot.send(text, sink, owner, messenger));
    }
    if (req.method === "GET") {
      try {
        const messages = await bot.list();
        const activity = await bot.listActivities?.();
        return Response.json({ messages, ...(activity?.length ? { activity } : {}) });
      } catch {
        return Response.json({ error: "bot_unavailable", message: ERROR_MESSAGES.bot_unavailable }, { status: 503 });
      }
    }
    return new Response(null, { status: 405 });
  };
}
