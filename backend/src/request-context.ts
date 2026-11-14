import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

// Legacy Private/hosted correlation headers intentionally keep their existing broader UUID syntax.
const LEGACY_CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS: Record<string, true> = {
  GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true,
  OPTIONS: true, CONNECT: true, TRACE: true,
};

export type StreamOutcome = "done" | "error" | "aborted";
export type CreditsBucket = "0" | "1-9" | "10-99" | "100-999" | "1000+";

export type RequestEvent = {
  event: "tinychat_request";
  request_id: string;
  request_id_replaced: boolean;
  method: string;
  /** Registered route template (mount template + terminal template), never baseUrl/originalUrl values. */
  route: string;
  status: number;
  duration_ms: number;
  correlation_id?: string;
  /** Streaming routes only: how the stream ended, plus a fixed error code. */
  stream?: StreamOutcome;
  code?: string;
  /** Bucket of the credits recorded for this request, when any were charged. */
  credits?: CreditsBucket;
  /** Keyed HMAC of the authenticated account and the record's UTC month; omitted when unauthenticated or no key is configured. */
  account_hash?: string;
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

/** Per-response facts a handler adds to its request record. Keyed by the response object, so it needs no async context. */
type RecordNotes = {
  mountBase?: string;
  mountTemplate?: string;
  stream?: StreamOutcome;
  code?: string;
  credits?: number;
  holds: number;
  release?: () => void;
};
const notes = new WeakMap<object, RecordNotes>();
const RECORD_CODE = /^[a-z][a-z0-9_]{0,59}$/;
/** A held record is emitted anyway this long after the response ended, so a stuck handler never loses it. */
const RECORD_HOLD_LIMIT_MS = 30_000;

let accountHashKey: string | undefined;

/** Set once at startup from REQUEST_LOG_HMAC_KEY (already validated). Undefined disables account_hash. */
export function configureRequestLogAccountHash(key: string | undefined): void {
  accountHashKey = key?.trim() || undefined;
}

/** hex(HMAC-SHA256(key, "account\0" || UTC "YYYY-MM" of `at` || "\0" || lowercase address)): a pseudonym that
 * changes every calendar month, never the address itself. Contract and vectors: tinycloud-dev ops/logging/pseudonyms.md.
 */
export function requestLogAccountHash(address: string, at: Date = new Date()): string | undefined {
  if (!accountHashKey) return undefined;
  const month = at.toISOString().slice(0, 7);
  return createHmac("sha256", accountHashKey).update(`account\0${month}\0${address.toLowerCase()}`).digest("hex");
}

/** The shipped record carries only the order of magnitude of a request's credits. */
export function requestLogCreditsBucket(credits: number): CreditsBucket {
  if (credits < 1) return "0";
  if (credits < 10) return "1-9";
  if (credits < 100) return "10-99";
  if (credits < 1000) return "100-999";
  return "1000+";
}

/** Add the stream outcome, a fixed error code or charged credits to this response's request record. */
export function noteRequestRecord(res: object, fields: { stream?: StreamOutcome; code?: string; credits?: number }): void {
  const note = notes.get(res);
  if (!note) return;
  if (fields.stream) note.stream = fields.stream;
  if (fields.code !== undefined && RECORD_CODE.test(fields.code)) note.code = fields.code;
  if (fields.credits !== undefined && Number.isSafeInteger(fields.credits) && fields.credits >= 0) {
    note.credits = (note.credits ?? 0) + fields.credits;
  }
}

function holdRequestRecord(res: object): () => void {
  const note = notes.get(res);
  if (!note) return () => {};
  note.holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    note.holds--;
    note.release?.();
  };
}

/** For handlers that settle their outcome or charge after the response ends (streams): the request record
 * waits until the handler's promise settles, so it carries them.
 */
export function recordAfterHandler(handler: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return async (req, res, next) => {
    const release = holdRequestRecord(res);
    try {
      await handler(req, res, next);
    } finally {
      release();
    }
  };
}

/** Record each string mount's template (e.g. "/api/chat") so the request record can name the full route
 * template without reading baseUrl, whose values can carry path parameters. Call before mounting routers.
 */
export function recordMountTemplates(app: Express): void {
  const use = app.use;
  // Express types `use` as an overload set; this wrapper only passes arguments through.
  Reflect.set(app, "use", (...args: unknown[]) => {
    const [template, ...handlers] = args;
    if (typeof template !== "string" || handlers.length === 0) return Reflect.apply(use, app, args);
    const mark: RequestHandler = (req, res, next) => {
      const note = notes.get(res);
      if (note) {
        note.mountBase = req.baseUrl;
        note.mountTemplate = template;
      }
      next();
    };
    return Reflect.apply(use, app, [template, mark, ...handlers]);
  });
}

function routeTemplate(req: Request, note: RecordNotes): string {
  const terminal: unknown = req.route?.path;
  if (typeof terminal !== "string") return "unmatched";
  let route = terminal;
  // baseUrl is compared, never copied: only the template recorded for the same mount is used.
  if (req.baseUrl && note.mountTemplate !== undefined && note.mountBase === req.baseUrl) {
    route = note.mountTemplate + (terminal === "/" ? "" : terminal);
  }
  return route.length <= 256 ? route : "unmatched";
}

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
    const note: RecordNotes = { holds: 0 };
    notes.set(res, note);
    let ended: number | undefined;
    let emitted = false;
    let holdLimit: NodeJS.Timeout | undefined;
    const send = () => {
      if (emitted || ended === undefined) return;
      emitted = true;
      // Nothing may keep this request (and its parsed body) reachable once the record is out.
      clearTimeout(holdLimit);
      holdLimit = undefined;
      note.release = undefined;
      res.off("finish", end);
      res.off("close", end);
      try {
        const correlation = res.getHeader("x-correlation-id");
        const address = req.user?.address;
        const accountHash = address ? requestLogAccountHash(address) : undefined;
        emit({
          event: "tinychat_request",
          request_id: requestId,
          request_id_replaced: incoming !== undefined && normalized === undefined,
          method: Object.hasOwn(METHODS, req.method) ? req.method : "OTHER",
          route: routeTemplate(req, note),
          // 499: the client closed the connection before any response was sent.
          status: res.headersSent ? res.statusCode : 499,
          duration_ms: Math.max(0, ended - started),
          // Private/hosted correlation remains independent, including when callers send both IDs.
          ...(typeof correlation === "string" && LEGACY_CORRELATION_ID.test(correlation) ? { correlation_id: correlation.toLowerCase() } : {}),
          ...(note.stream ? { stream: note.stream } : {}),
          ...(note.code ? { code: note.code } : {}),
          ...(note.credits !== undefined ? { credits: requestLogCreditsBucket(note.credits) } : {}),
          ...(accountHash ? { account_hash: accountHash } : {}),
        });
      } catch {
        // The record is best effort: it never breaks or delays a response.
      }
    };
    note.release = () => { if (note.holds === 0) send(); };
    const end = () => {
      if (ended !== undefined) return;
      ended = performance.now();
      if (note.holds === 0) return send();
      holdLimit = setTimeout(send, RECORD_HOLD_LIMIT_MS);
      holdLimit.unref?.();
    };
    context.run({ requestId, emit }, () => {
      res.once("finish", end);
      // A client that disconnects first may never produce "finish".
      res.once("close", end);
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
