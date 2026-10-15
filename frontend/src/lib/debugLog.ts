import { Capacitor, registerPlugin } from "@capacitor/core";

export type DebugEvent = {
  at: string;
  kind: "request" | "pipeline" | "session" | "native";
  source_id: string | null;
  phase?: string;
  engine?: string;
  destination?: string;
  method?: string;
  path?: string;
  status?: number;
  bodyBytes?: number;
  totalBytes?: number;
  progressPct?: number;
  responseBytes?: number;
  durationMs?: number;
  code?: string;
  operation?: string;
  count?: number;
  chain?: { name?: string; code?: string; status?: number; message?: string }[];
};

const events: DebugEvent[] = [];
const listeners = new Set<() => void>();
let enabled = import.meta.env.DEV;
const nativeLog = registerPlugin<{ append(options: { line: string }): Promise<void> }>("ExoDevLog");
const recordingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function debugLogEnabled(): boolean { return enabled; }
/** Lets tests exercise the log without depending on the build mode. */
export function setDebugLogEnabledForTests(on: boolean): void { enabled = on; }
export function debugEvents(): readonly DebugEvent[] { return events; }
export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Diagnostics may be copied or printed by WebKit. Never store arbitrary objects, headers, or bodies.
export function redactDebugText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/wants you to sign in with|\bSIWE\b|\bSign-In with Ethereum\b/i.test(value)) return "<redacted sign-in message>";
  if (/\bdelegation(?:Body|Payload)?\b|privateJwk|sessionPayload|\bSIWE\b/i.test(value))
    return "<redacted session data>";
  return value.replace(/https?:\/\/\S+/gi, "<url>")
    // Header values may contain spaces and use any auth scheme. Consume the
    // complete quoted value or the rest of the header line.
    .replace(/\b((?:proxy-authorization|authorization|set-cookie|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]*)/gi, "$1<redacted>")
    .replace(/\b(bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/\b(d|jwt|session[_-]?key|(?:private[_-]?)?jwk|nonce|ucan|cacao|signature|delegation(?:Body|Payload)?|(?:access|id|refresh)[_-]?token|token|(?:client[_-]?)?secret|password|api[_-]?key|siwe|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, "$1$2<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/g, "<redacted token>")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "<redacted key>")
    .replace(/\b(?:0x)?[a-fA-F0-9]{32,}\b/g, "<redacted hex>")
    .replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{64,}={0,2}(?![A-Za-z0-9+/_-])/g, "<redacted bytes>")
    .slice(0, 500);
}

export function debugErrorChain(error: unknown): NonNullable<DebugEvent["chain"]> {
  const chain: NonNullable<DebugEvent["chain"]> = [];
  const seen = new Set<unknown>();
  for (let current = error; current != null && chain.length < 12 && !seen.has(current);) {
    seen.add(current);
    const value = typeof current === "object" ? current as Record<string, unknown> : null;
    const status = value?.status ?? (value?.meta as { status?: unknown } | undefined)?.status;
    chain.push({
      name: redactDebugText(current instanceof Error ? current.name : value?.name),
      code: redactDebugText(value?.code),
      status: typeof status === "number" ? status : undefined,
      message: redactDebugText(current instanceof Error ? current.message : value?.message ?? current),
    });
    current = value?.cause;
  }
  return chain;
}

function append(event: Omit<DebugEvent, "at">): void {
  if (!enabled) return;
  const sourceId = event.source_id;
  const entry = {
    ...event,
    at: new Date().toISOString(),
    source_id: sourceId && recordingIdPattern.test(sourceId) ? sourceId : null,
    operation: redactDebugText(event.operation),
    phase: redactDebugText(event.phase),
    engine: redactDebugText(event.engine),
    destination: redactDebugText(event.destination),
    path: event.path, // requestPath already removes all variable route segments
  };
  events.push(entry);
  if (events.length > 300) events.shift();
  const line = JSON.stringify(entry);
  if (Capacitor.isNativePlatform()) {
    void nativeLog.append({ line }).catch(() => undefined);
  } else if ("__TAURI_INTERNALS__" in globalThis) {
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("append_dev_log", { line })).catch(() => undefined);
  } else {
    console.info(line);
  }
  listeners.forEach((listener) => listener());
}

export function logPipeline(operation: string, sourceId: string, phase: string,
  details: Pick<DebugEvent, "engine" | "destination" | "bodyBytes" | "totalBytes" | "progressPct" | "status"> = {}): void {
  append({ kind: "pipeline", source_id: sourceId, operation, phase, ...details });
}
export function logPipelineCount(operation: string, phase: string, count = 1): void {
  const event = { kind: "pipeline" as const, source_id: null, operation, phase, count };
  if (enabled) append(event);
  else console.info(JSON.stringify({ ...event, at: new Date().toISOString() }));
}

export function logSession(operation: string, phase: string, error?: unknown): void {
  append({ kind: "session", source_id: null, operation, phase,
    ...(error === undefined ? {} : { chain: debugErrorChain(error) }) });
}

export function logPipelineError(operation: string, error: unknown, sourceId: string | null = null): void {
  const chain = debugErrorChain(error);
  append({ kind: "pipeline", source_id: sourceId, operation, phase: "failed", code: chain[0]?.code, chain });
}

function bodyBytes(body: BodyInit | null | undefined): number | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function requestPath(url: string): string | null {
  try {
    const parsed = new URL(url, location.href);
    const backend = new URL(import.meta.env.VITE_BACKEND_URL || "http://localhost:3014", location.href);
    if (!(/(^|\.)tinycloud\.(xyz|chat)$/.test(parsed.hostname) ||
      (parsed.origin === backend.origin && parsed.pathname.startsWith("/api/")))) return null;
    // Drop query and fragment; only known route words survive. Space IDs and
    // storage keys can themselves contain credentials, even when short.
    const routeWords = new Set(["api", "v1", "v2", "kv", "sql", "spaces", "chat", "auth", "nonce", "verify",
      "manifest", "billing", "agent", "session", "jobs", "uploads", "audio", "transcript", "connectors"]);
    const path = parsed.pathname.split("/").map((segment) => routeWords.has(segment) ? segment : segment ? "<id>" : "").join("/");
    return `${parsed.origin === backend.origin ? "backend" : "tinycloud"}${path}`;
  } catch { return null; }
}

function nativeSourceId(plugin: string, options: unknown): string | null {
  if (plugin !== "VoiceNotes" && plugin !== "OnDeviceStt") return null;
  if (!options || typeof options !== "object") return null;
  const id = (options as { id?: unknown }).id;
  return typeof id === "string" && recordingIdPattern.test(id) ? id : null;
}

export async function installDebugLog(): Promise<void> {
  if (!enabled && Capacitor.isNativePlatform()) {
    enabled = Capacitor.isPluginAvailable("ExoDevLog");
    if (enabled) listeners.forEach((listener) => listener());
  } else if (!enabled && "__TAURI_INTERNALS__" in globalThis) {
    enabled = await import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<boolean>("debug_logging_enabled")).catch(() => false);
    if (enabled) listeners.forEach((listener) => listener());
  }
  if (!enabled) return;
  // Capacitor cannot redact bridge payloads. loggingBehavior remains none;
  // record only method and outcome, never arguments or results.
  if (Capacitor.isNativePlatform()) {
    const bridge = Capacitor as typeof Capacitor & {
      nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
      nativeCallback?: (plugin: string, method: string, options: unknown, callback: (...args: unknown[]) => void) => string;
    };
    const originalNativePromise = bridge.nativePromise?.bind(bridge);
    if (originalNativePromise) bridge.nativePromise = async (plugin, method, options) => {
      if (plugin === "ExoDevLog") return originalNativePromise(plugin, method, options);
      const started = performance.now();
      try {
        const result = await originalNativePromise(plugin, method, options);
        append({ kind: "native", source_id: nativeSourceId(plugin, options), operation: `${plugin}.${method}`,
          phase: "done", durationMs: Math.round(performance.now() - started) });
        return result;
      } catch (error) {
        append({ kind: "native", source_id: nativeSourceId(plugin, options), operation: `${plugin}.${method}`,
          phase: "failed", durationMs: Math.round(performance.now() - started) });
        throw error;
      }
    };
    const originalNativeCallback = bridge.nativeCallback?.bind(bridge);
    if (originalNativeCallback) bridge.nativeCallback = (plugin, method, options, callback) => {
      append({ kind: "native", source_id: nativeSourceId(plugin, options), operation: `${plugin}.${method}`, phase: "start" });
      return originalNativeCallback(plugin, method, options, callback);
    };
  }
  if (typeof fetch !== "function") return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const path = requestPath(request?.url ?? String(input));
    if (!path) return original(input, init);
    const started = performance.now();
    const common = { kind: "request" as const, source_id: null,
      method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
      path, bodyBytes: bodyBytes(init?.body) };
    try {
      const response = await original(input, init);
      append({ ...common, status: response.status, durationMs: Math.round(performance.now() - started),
        responseBytes: Number(response.headers.get("content-length")) || undefined,
        code: response.ok ? undefined : `HTTP_${response.status}` });
      return response;
    } catch (error) {
      append({ ...common, durationMs: Math.round(performance.now() - started),
        code: error instanceof TypeError ? "FETCH_REJECTED" : redactDebugText((error as { code?: unknown } | null)?.code) ?? "FETCH_FAILED",
        chain: debugErrorChain(error) });
      throw error;
    }
  };
}
