/**
 * TC-1964: optional, one-time, read-only startup count of stored connector credential rows.
 *
 * `CREDENTIAL_ROW_COUNT_SOURCES` is a comma-separated list of source names (e.g. `fireflies`).
 * Unset or empty: nothing runs and the store is never built. Set: for each source the backend KV
 * prefix `credentials/<source>/` is listed (all pages) through the credential row store's own lane
 * and node session, and exactly one line is logged:
 *
 *   credential_row_count source=<source> count=<N>
 *   credential_row_count source=<source> count=unavailable code=<CODE>
 *
 * Codes (fixed): LIST_FAILED (any failure), LIST_TRUNCATED (the listing could not be proven
 * complete; a partial number is never reported), INVALID_SOURCE. Source validity is decided by the
 * store itself (`KvCredentialRowStore.countRows` uses the store's own source validator before any
 * KV call); an invalid name is NOT echoed — its line carries the fixed placeholder `source=invalid`.
 * Only the number is ever logged — never a key, address, cursor, row value or error message.
 * Nothing here throws, retries or blocks boot.
 *
 * This module deliberately imports nothing, so wiring it into index.ts adds no module edges.
 */

export const CREDENTIAL_ROW_COUNT_ENV = "CREDENTIAL_ROW_COUNT_SOURCES";
export const CREDENTIAL_ROW_COUNT_LIST_FAILED = "LIST_FAILED";
export const CREDENTIAL_ROW_COUNT_LIST_TRUNCATED = "LIST_TRUNCATED";
export const CREDENTIAL_ROW_COUNT_INVALID_SOURCE = "INVALID_SOURCE";
/** Hard page cap: beyond this the count is reported unavailable, never partial. */
export const CREDENTIAL_ROW_COUNT_MAX_PAGES = 1000;

type CredentialRowCountCode =
  | typeof CREDENTIAL_ROW_COUNT_LIST_TRUNCATED
  | typeof CREDENTIAL_ROW_COUNT_INVALID_SOURCE;

/** Carries only a fixed code — never a key, cursor or value. */
export class CredentialRowCountError extends Error {
  constructor(readonly code: CredentialRowCountCode) {
    super(code);
    this.name = "CredentialRowCountError";
  }
}

export interface CredentialRowCounter {
  countRows(source: string): Promise<number>;
}

function fixedCode(error: unknown): string {
  if (error instanceof CredentialRowCountError) return error.code;
  return CREDENTIAL_ROW_COUNT_LIST_FAILED;
}

/** Echo a name only when it is trivially safe; anything else (or any invalid source) is "invalid". */
function shownSource(source: string, code: string): string {
  return code !== CREDENTIAL_ROW_COUNT_INVALID_SOURCE && /^[a-z0-9-]{1,32}$/.test(source) ? source : "invalid";
}

function unavailableLine(source: string, code: string): string {
  return `credential_row_count source=${shownSource(source, code)} count=unavailable code=${code}`;
}

export type CredentialRowCountResult =
  | { source: string; count: number }
  | { source: string; count: null; code: string };

/**
 * One count as a value, for the optional authenticated HTTP read: the same `countRows`, the same
 * fixed codes and the same source echo rule as the startup line. Never throws; a non-string source
 * is INVALID_SOURCE without touching the store.
 */
export async function countCredentialRows(
  store: CredentialRowCounter | (() => CredentialRowCounter),
  source: unknown,
): Promise<CredentialRowCountResult> {
  const name = typeof source === "string" ? source : "";
  try {
    if (typeof source !== "string") throw new CredentialRowCountError(CREDENTIAL_ROW_COUNT_INVALID_SOURCE);
    const counter = typeof store === "function" ? store() : store;
    const count = await counter.countRows(source);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid count");
    return { source: shownSource(name, ""), count };
  } catch (error) {
    const code = fixedCode(error);
    return { source: shownSource(name, code), count: null, code };
  }
}

/** Resolves once every listed source has been logged. Never rejects. */
export async function logCredentialRowCounts(
  raw: string | undefined,
  makeStore: () => CredentialRowCounter,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  try {
    const entries: string[] = [];
    for (const part of (raw ?? "").split(",")) {
      const entry = part.trim();
      if (entry.length > 0 && !entries.includes(entry)) entries.push(entry);
    }
    if (entries.length === 0) return;

    let store: CredentialRowCounter | null = null;
    try {
      store = makeStore();
    } catch {
      store = null;
    }
    // Sequential: the store's lane serialises KV calls on the backend space anyway.
    for (const source of entries) {
      try {
        if (store === null) throw new Error("store unavailable");
        const count = await store.countRows(source);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid count");
        log(`credential_row_count source=${source} count=${count}`);
      } catch (error) {
        log(unavailableLine(source, fixedCode(error)));
      }
    }
  } catch {
    // Diagnostics must never affect boot.
  }
}
