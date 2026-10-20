import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

// Legacy Private/hosted correlation headers intentionally keep their existing broader UUID syntax.
const LEGACY_CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS: Record<string, true> = {
  GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true,
  OPTIONS: true, CONNECT: true, TRACE: true,
};

export type RequestEvent = {
  event: "tinychat_request";
  request_id: string;
  request_id_replaced: boolean;
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
} | {
  event: "tinychat_background_diagnostic";
  level: "info" | "error";
};

type EventSink = (event: RequestEvent) => void;
const context = new AsyncLocalStorage<{ requestId?: string; emit: EventSink }>();

/** The backend entry ID, available to outbound HTTP without threading credentials or request objects. */
export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId;
}

/** Shared TC-959 full-value predicate; HTTP frameworks may fold repeated fields with commas. */
export function normalizeRequestId(incoming: string | undefined): string | undefined {
  if (incoming === undefined || incoming.length !== 36 || !REQUEST_ID.test(incoming)) return undefined;
  return incoming.toLowerCase();
}

/** Restore only an item's origin ID, never its HTTP request/emitter. Undefined removes attribution
 * while retaining payload-safe diagnostics for shared drains, sweeps and cleanup.
 */
export function runWithRequestId<T>(requestId: string | undefined, operation: () => T): T {
  return context.run({ requestId: normalizeRequestId(requestId), emit: emitToStdout }, operation);
}

/** Explicit classification, separate from configurable PTX destinations. Empty means deny all. */
export function parseRequestIdFirstPartyOrigins(value: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  if (!value?.trim()) return origins;
  for (const entry of value.split(",")) {
    try {
      const url = new URL(entry.trim());
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.href !== url.origin + "/") throw new Error();
      origins.add(url.origin);
    } catch {
      throw new Error("REQUEST_ID_FIRST_PARTY_ORIGINS must contain only comma-separated HTTP(S) origins");
    }
  }
  return origins;
}

function emitToStdout(event: RequestEvent): void {
  // Only this typed projection bypasses the request output boundary.
  context.exit(() => process.stdout.write(JSON.stringify(event) + "\n"));
}

export function createRequestContextMiddleware(emit: EventSink = emitToStdout): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get("x-request-id");
    const normalized = normalizeRequestId(incoming);
    const requestId = normalized ?? randomUUID();
    const started = performance.now();
    res.setHeader("X-Request-Id", requestId);
    context.run({ requestId, emit }, () => {
      res.once("finish", () => {
        const route: unknown = req.route?.path;
        const correlation = res.getHeader("x-correlation-id");
        emit({
          event: "tinychat_request",
          request_id: requestId,
          request_id_replaced: incoming !== undefined && normalized === undefined,
          method: Object.hasOwn(METHODS, req.method) ? req.method : "OTHER",
          route: typeof route === "string" && route.length <= 256 ? route : "unmatched",
          status: res.statusCode,
          duration_ms: Math.max(0, performance.now() - started),
          // Private/hosted correlation remains independent, including when callers send both IDs.
          ...(typeof correlation === "string" && LEGACY_CORRELATION_ID.test(correlation) ? { correlation_id: correlation.toLowerCase() } : {}),
        });
      });
      next();
    });
  };
}

let installed = false;

/** Keep scoped request/worker diagnostics observable without inspecting their payloads.
 * Logging outside an opted-in scope is unchanged.
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
      const level = method === "warn" || method === "error" || method === "trace" || method === "assert" ? "error" : "info";
      active.emit(active.requestId === undefined
        ? { event: "tinychat_background_diagnostic", level }
        : { event: "tinychat_request_diagnostic", request_id: active.requestId, level });
    };
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    stream.write = function (
      this: typeof stream,
      ...args: [
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error) => void),
        callback?: (error?: Error) => void,
      ]
    ): boolean {
      const active = context.getStore();
      if (!active) return Reflect.apply(original, this, args);
      const level = stream === process.stderr ? "error" : "info";
      active.emit(active.requestId === undefined
        ? { event: "tinychat_background_diagnostic", level }
        : { event: "tinychat_request_diagnostic", request_id: active.requestId, level });
      const [, encodingOrCallback, callback] = args;
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (done) queueMicrotask(done);
      return true;
    };
  }
}
