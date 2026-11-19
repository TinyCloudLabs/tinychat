// Internal HTTP API, called only by the TinyChat backend (docs/plans/tiny-bots-slice1.md, piece 1).
// Every SSE event is encoded here from checked fields; nothing from a sandbox is passed through raw.

import type { StagedHistory } from "./history";
import { type ErrorCode, ERROR_MESSAGES, type ListedMessage, MAX_TEXT, type TurnSink } from "./bot";
import { isRecord } from "./guards";
import { ANNOUNCED_STATES, type AnnouncedState, type BotState } from "./manifest";
import { legacyOwnerHeaderAccepted } from "./config";
import { authorizedOwner, isBotKey, MAIN_KEY, ownerAllowed } from "./owner";
import { type Environment, NonceGuard, SIGNED_SCHEME, verifyCall } from "./signed-call";
import type { DeleteSkip } from "./retention";

/** `/v1/bots/<key>` and what follows it. The key is checked before anything is built from it. */
const BOT_PATH = /^\/v1\/bots\/([^/]+)(\/.*)?$/;

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
  if (rest === "/messages") return method === "POST" ? "turn" : "read";
  if (rest === "/history" || rest === "/history/stage" || rest === "/history/permission" || rest === "/history/notice") return "history";
  return undefined;
}

export interface BotApi {
  send(text: string, sink: TurnSink, owner?: string): Promise<void>;
  list(): Promise<ListedMessage[]>;
  historyPending?(): Promise<unknown>;
  historyStage?(staged: StagedHistory): Promise<void>;
  historyPermission?(owner: string, expiresAt?: number, validUntil?: number): Promise<void>;
  historyNotice?(): Promise<unknown>;
  historyNoticeAck?(id: string, receivedAt: number): Promise<void>;
  historyReceipt?(receipt: unknown): Promise<void>;
}

export interface AppOptions {
  /** This service's secret. */
  secret: string;
  accounts: Set<string> | "*";
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

function eventStream(run: (sink: TurnSink) => Promise<void>): Response {
  let open = true;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const send = (event: string, data: Record<string, string>) => {
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
  return Response.json({ state: manifest.announce(owner, key, state, seq) });
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
  return Response.json({ outcome: cause === "archive_pending" || cause === "closing" ? "waiting" : "failed", cause });
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
    if (authorization?.startsWith(SIGNED_SCHEME)) {
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
      const text = isRecord(body) ? body.text : undefined;
      if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
        return eventStream(async sink => sink.error("invalid"));
      }
      return eventStream(sink => bot.send(text, sink, owner));
    }
    if (req.method === "GET") {
      try {
        return Response.json({ messages: await bot.list() });
      } catch {
        return Response.json({ error: "bot_unavailable", message: ERROR_MESSAGES.bot_unavailable }, { status: 503 });
      }
    }
    return new Response(null, { status: 405 });
  };
}
