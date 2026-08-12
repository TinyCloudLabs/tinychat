import { TinyCloudNode } from "@tinycloud/node-sdk";

// ── Configuration ────────────────────────────────────────────────────

export interface BackendIdentityConfig {
  /** Ethereum private key with 0x prefix */
  privateKey: string;
  /** TinyCloud node host */
  host?: string;
  /** KV key prefix for backend data */
  prefix: string;
  /** Automatically create a space if one doesn't exist */
  autoCreateSpace?: boolean;
}

export interface BackendIdentity {
  node: TinyCloudNode;
  did: string;
}

// ── Create Backend Identity ──────────────────────────────────────────

export function validateBackendPrefix(prefix: string | undefined): string {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error(
      "createBackendIdentity requires an explicit prefix for backend-owned operational state",
    );
  }

  if (prefix.includes("/") || prefix.includes("\\")) {
    throw new Error(
      "createBackendIdentity prefix must be slash- and backslash-free",
    );
  }

  return prefix;
}

/**
 * Initialize a TinyCloudNode instance with the given private key,
 * sign in, and return the node + its DID.
 *
 * This is the backend's own identity — used to store delegations
 * and access user data via delegated capabilities.
 */
export async function createBackendIdentity(
  config: BackendIdentityConfig,
): Promise<BackendIdentity> {
  const prefix = validateBackendPrefix(config.prefix);
  const node = new TinyCloudNode({
    privateKey: config.privateKey,
    host: config.host ?? "https://node.tinycloud.xyz",
    prefix,
    autoCreateSpace: config.autoCreateSpace ?? true,
  });

  await node.signIn();

  return {
    node,
    did: node.did,
  };
}

// ── KV Result failure contract ───────────────────────────────────────

interface StructuredKvError {
  code?: unknown;
  message?: unknown;
  service?: unknown;
  status?: unknown;
  meta?: unknown;
}

const SAFE_KV_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SESSION_ERROR_PATTERN =
  /\b(session\s+expired|invalid\s+session|token\s+expired|expired\s+credentials?|unauthorized|unauthenticated|sign.?in\s*required)\b|\b401\b(?![\d-])/i;

function safeStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : undefined;
}

/** A structured, log-safe representation of an SDK Result failure. */
export class KvResultError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly meta?: unknown;
  readonly #legacySessionError: boolean;

  constructor(error: unknown) {
    const legacyMessage =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "";
    if (
      error !== null &&
      typeof error === "object" &&
      !(error instanceof Error)
    ) {
      const structured = error as StructuredKvError;
      const code =
        typeof structured.code === "string" ? structured.code : undefined;
      const meta = structured.meta;
      const status =
        safeStatus(structured.status) ??
        safeStatus(
          meta !== null && typeof meta === "object"
            ? (meta as { status?: unknown }).status
            : undefined,
        );
      const safeCode =
        code !== undefined && SAFE_KV_CODE_PATTERN.test(code)
          ? code
          : undefined;
      const details = [
        safeCode === undefined ? null : `code=${safeCode}`,
        status === undefined ? null : `status=${status}`,
      ].filter((detail): detail is string => detail !== null);
      super(
        details.length === 0
          ? "KV operation failed"
          : `KV operation failed: ${details.join(" ")}`,
      );
      this.code = safeCode;
      this.status = status;
      this.meta = meta;
    } else {
      super("KV operation failed");
      this.code = undefined;
      this.status = undefined;
      this.meta = undefined;
    }
    this.name = "KvResultError";
    this.#legacySessionError = SESSION_ERROR_PATTERN.test(legacyMessage);
  }

  isLegacySessionError(): boolean {
    return this.#legacySessionError;
  }
}

/**
 * Match only the SDK's exact production response for an absent requested key.
 * A missing space deliberately does not match even though it shares KV_NOT_FOUND.
 */
export function isKvMissingKeyResult(result: unknown, key: string): boolean {
  if (result === null || typeof result !== "object") return false;
  const candidate = result as { ok?: unknown; error?: unknown };
  if (
    candidate.ok !== false ||
    candidate.error === null ||
    typeof candidate.error !== "object"
  ) {
    return false;
  }
  const error = candidate.error as StructuredKvError;
  return (
    error.code === "KV_NOT_FOUND" &&
    error.service === "kv" &&
    error.message === `Key not found: ${key}`
  );
}

/**
 * The node SDK's KV surface resolves to a Result: `{ ok: true, data }` on success and
 * `{ ok: false, error }` on durable failure — the promise no longer rejects on kv-side errors.
 * Silently accepting `{ ok: false }` reports "stored" while the write never landed, so persistence
 * has to detect and re-throw that shape as a redacted actionable error.
 *
 * Legacy fakes and successful legacy shapes (bare void, `{ data }` without an `ok` discriminator,
 * `{ ok: true, ... }`) are passed through unchanged. Only an explicit `ok === false` is fatal.
 *
 * This helper is called INSIDE the callback passed to `withSessionRefresh`, which classifies
 * structured session codes and status without relying on the untrusted service message.
 */
export function assertKvResult<T>(result: T): T {
  if (
    result != null &&
    typeof result === "object" &&
    "ok" in (result as unknown as object)
  ) {
    const r = result as unknown as { ok: unknown; error?: unknown };
    if (r.ok === false) {
      throw new KvResultError(r.error);
    }
  }
  return result;
}

// ── Session Error Detection ──────────────────────────────────────────

function isSessionError(err: unknown): boolean {
  if (err instanceof KvResultError) {
    return (
      err.code === "AUTH_REQUIRED" ||
      err.code === "AUTH_EXPIRED" ||
      err.code === "AUTH_UNAUTHORIZED" ||
      err.status === 401 ||
      err.isLegacySessionError()
    );
  }
  if (err !== null && typeof err === "object") {
    const structured = err as {
      code?: unknown;
      status?: unknown;
      meta?: unknown;
    };
    if (
      structured.code === "AUTH_REQUIRED" ||
      structured.code === "AUTH_EXPIRED" ||
      structured.code === "AUTH_UNAUTHORIZED"
    ) {
      return true;
    }
    const status =
      safeStatus(structured.status) ??
      safeStatus(
        structured.meta !== null && typeof structured.meta === "object"
          ? (structured.meta as { status?: unknown }).status
          : undefined,
      );
    if (status === 401) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return SESSION_ERROR_PATTERN.test(message);
}

// ── Session Refresh Wrapper ──────────────────────────────────────────

/**
 * Wraps an async function so that if it fails with a session-related error,
 * the node re-signs-in and the function is retried once.
 *
 * Use this around any TinyCloud KV/SQL operation that might fail due
 * to an expired session.
 */
export async function withSessionRefresh<T>(
  node: TinyCloudNode,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isSessionError(err)) {
      // Re-authenticate and retry once
      await node.signIn();
      return fn();
    }

    throw err;
  }
}
