import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

export type DebugEvent = {
  at: string;
  kind: "request" | "pipeline";
  method?: string;
  path?: string;
  status?: number;
  bodyBytes?: number;
  durationMs?: number;
  code?: string;
  operation?: string;
  chain?: { name?: string; code?: string; status?: number; message?: string }[];
};

const events: DebugEvent[] = [];
const listeners = new Set<() => void>();
let enabled = import.meta.env.DEV;

export function debugLogEnabled(): boolean { return enabled; }
export function debugEvents(): readonly DebugEvent[] { return events; }
export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Diagnostics may be copied or printed by WebKit. Never store arbitrary objects, headers, or bodies.
function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/wants you to sign in with|\bSIWE\b|\bSign-In with Ethereum\b/i.test(value)) return "<redacted sign-in message>";
  return value.replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b(bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/\b(d|token|accessToken|refreshToken|secret|password|authorization|api[_-]?key|siwe|signature|private[_-]?key|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, "$1$2<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted token>")
    .replace(/\b(?:0x)?[a-fA-F0-9]{32,}\b/g, "<redacted hex>")
    .slice(0, 240);
}

export function debugErrorChain(error: unknown): NonNullable<DebugEvent["chain"]> {
  const chain: NonNullable<DebugEvent["chain"]> = [];
  const seen = new Set<unknown>();
  for (let current = error; current != null && chain.length < 12 && !seen.has(current);) {
    seen.add(current);
    const value = typeof current === "object" ? current as Record<string, unknown> : null;
    const status = value?.status ?? (value?.meta as { status?: unknown } | undefined)?.status;
    chain.push({
      name: safeText(current instanceof Error ? current.name : value?.name),
      code: safeText(value?.code),
      status: typeof status === "number" ? status : undefined,
      message: safeText(current instanceof Error ? current.message : value?.message ?? current),
    });
    current = value?.cause;
  }
  return chain;
}

function append(event: Omit<DebugEvent, "at">): void {
  if (!enabled) return;
  const entry = { at: new Date().toISOString(), ...event };
  events.push(entry);
  if (events.length > 300) events.shift();
  // Capacitor forwards web console lines to the native system log (#319).
  console.warn(`[Exo debug] ${JSON.stringify(entry)}`);
  listeners.forEach((listener) => listener());
}

export function logPipelineError(operation: string, error: unknown): void {
  append({ kind: "pipeline", operation, code: debugErrorChain(error)[0]?.code, chain: debugErrorChain(error) });
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
    return `${parsed.host}${path}`;
  } catch { return null; }
}

export async function installDebugLog(): Promise<void> {
  if (!enabled && Capacitor.isNativePlatform()) {
    enabled = (await CapacitorApp.getInfo().catch(() => null))?.id === "xyz.tinycloud.exo.dev";
    if (enabled) listeners.forEach((listener) => listener());
  }
  if (!enabled || typeof fetch !== "function") return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const path = requestPath(request?.url ?? String(input));
    if (!path) return original(input, init);
    const started = performance.now();
    const common = { kind: "request" as const, method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
      path, bodyBytes: bodyBytes(init?.body) };
    try {
      const response = await original(input, init);
      append({ ...common, status: response.status, durationMs: Math.round(performance.now() - started),
        code: response.ok ? undefined : `HTTP_${response.status}` });
      return response;
    } catch (error) {
      append({ ...common, durationMs: Math.round(performance.now() - started),
        code: error instanceof TypeError ? "FETCH_REJECTED" : safeText((error as { code?: unknown } | null)?.code) ?? "FETCH_FAILED" });
      throw error;
    }
  };
}
