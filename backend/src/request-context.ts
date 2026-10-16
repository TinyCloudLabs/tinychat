import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS: Record<string, true> = {
  GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true,
  OPTIONS: true, CONNECT: true, TRACE: true,
};

export type RequestEvent = {
  event: "tinychat_request";
  request_id: string;
  method: string;
  /** Registered terminal route template, never baseUrl/originalUrl (which contain parameter values). */
  route: string;
  status: number;
  duration_ms: number;
  correlation_id?: string;
} | {
  event: "tinychat_request_diagnostic";
  request_id: string;
  level: "info" | "error";
};

type EventSink = (event: RequestEvent) => void;
const context = new AsyncLocalStorage<{ requestId: string; emit: EventSink }>();

/** The backend entry ID, available to outbound HTTP without threading credentials or request objects. */
export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId;
}

function emitToStdout(event: RequestEvent): void {
  // Only this typed projection bypasses the request output boundary.
  context.exit(() => process.stdout.write(JSON.stringify(event) + "\n"));
}

export function createRequestContextMiddleware(emit: EventSink = emitToStdout): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get("x-request-id");
    const requestId = incoming !== undefined && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();
    const started = performance.now();
    res.setHeader("X-Request-Id", requestId);
    context.run({ requestId, emit }, () => {
      res.once("finish", () => {
        const route: unknown = req.route?.path;
        const correlation = res.getHeader("x-correlation-id");
        emit({
          event: "tinychat_request",
          request_id: requestId,
          method: Object.hasOwn(METHODS, req.method) ? req.method : "OTHER",
          route: typeof route === "string" && route.length <= 256 ? route : "unmatched",
          status: res.statusCode,
          duration_ms: Math.max(0, performance.now() - started),
          // Private/hosted correlation remains independent, including when callers send both IDs.
          ...(typeof correlation === "string" && UUID.test(correlation) ? { correlation_id: correlation.toLowerCase() } : {}),
        });
      });
      next();
    });
  };
}

let installed = false;

/** Keep legacy request/dependency diagnostics observable, but never inspect or emit their payloads.
 * Outside HTTP request context, existing startup/background logging is unchanged.
 */
export function installRequestLogBoundary(): void {
  if (installed) return;
  installed = true;
  // Bun's console can bypass process.stdout.write, so guard both entry points.
  for (const method of [
    "log", "info", "debug", "warn", "error", "trace", "dir", "dirxml", "table", "assert",
    "count", "countReset", "time", "timeEnd", "timeLog", "group", "groupCollapsed", "groupEnd",
  ] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const active = context.getStore();
      if (!active) return Reflect.apply(original, console, args);
      active.emit({
        event: "tinychat_request_diagnostic", request_id: active.requestId,
        level: method === "warn" || method === "error" || method === "trace" || method === "assert" ? "error" : "info",
      });
    };
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ): boolean => {
      const active = context.getStore();
      if (!active) {
        return typeof encodingOrCallback === "string"
          ? original(chunk, encodingOrCallback, callback)
          : original(chunk, encodingOrCallback);
      }
      active.emit({
        event: "tinychat_request_diagnostic", request_id: active.requestId,
        level: stream === process.stderr ? "error" : "info",
      });
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (done) queueMicrotask(done);
      return true;
    };
  }
}
