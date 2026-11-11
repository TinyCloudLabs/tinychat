// Internal HTTP API, called only by the TinyChat backend (docs/plans/tiny-bots-slice1.md, piece 1).
// Every SSE event is encoded here from checked fields; nothing from a sandbox is passed through raw.

import { type ErrorCode, ERROR_MESSAGES, type ListedMessage, MAX_TEXT, type TurnSink } from "./bot";
import { isRecord } from "./guards";
import { authorizedOwner } from "./owner";

const MESSAGES_PATH = "/v1/bots/main/messages";

export interface BotApi {
  send(text: string, sink: TurnSink): Promise<void>;
  list(): Promise<ListedMessage[]>;
}

export interface AppOptions {
  secret: string;
  accounts: Set<string> | "*";
  bots: { forOwner(ownerDid: string): BotApi };
}

const encoder = new TextEncoder();

function eventStream(run: (sink: TurnSink) => Promise<void>): Response {
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: Record<string, string>) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

export function createApp(options: AppOptions): (req: Request) => Promise<Response> {
  return async req => {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/healthz") return new Response("ok");
    const owner = authorizedOwner(req, options.secret, options.accounts);
    if (!owner) return new Response(null, { status: 401 });
    if (path !== MESSAGES_PATH) return new Response(null, { status: 404 });
    const bot = options.bots.forOwner(owner);

    if (req.method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const text = isRecord(body) ? body.text : undefined;
      if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
        return eventStream(async sink => sink.error("invalid"));
      }
      return eventStream(sink => bot.send(text, sink));
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
