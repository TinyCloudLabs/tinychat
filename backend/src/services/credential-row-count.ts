/**
 * TC-1964: optional, one-time, read-only startup count of stored connector credential rows.
 *
 * `CREDENTIAL_ROW_COUNT_SOURCES` is a comma-separated list of source names (e.g. `fireflies`).
 * Unset or empty: nothing runs and the store is never built. Set: for each source the backend KV
 * prefix `credentials/<source>/` is listed once, through the credential row store's own lane and
 * node session, and exactly one line is logged:
 *
 *   credential_row_count source=<source> count=<N>
 *   credential_row_count source=<source> count=unavailable code=<CODE>
 *
 * Only the number is ever logged — never a key, address, row value or error message. A source
 * name that fails validation is NOT echoed; it yields one line with the fixed placeholder
 * `source=invalid` and `code=INVALID_SOURCE`. Nothing here throws, retries or blocks boot.
 */

export const CREDENTIAL_ROW_COUNT_ENV = "CREDENTIAL_ROW_COUNT_SOURCES";
export const CREDENTIAL_ROW_COUNT_LIST_FAILED = "LIST_FAILED";
export const CREDENTIAL_ROW_COUNT_INVALID_SOURCE = "INVALID_SOURCE";

const SOURCE_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface CredentialRowCounter {
  countRows(source: string): Promise<number>;
}

function unavailableLine(source: string, code: string): string {
  return `credential_row_count source=${source} count=unavailable code=${code}`;
}

/** Resolves once every listed source has been logged. Never rejects. */
export async function logCredentialRowCounts(
  raw: string | undefined,
  makeStore: () => CredentialRowCounter,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  try {
    const entries = (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length === 0) return;

    const sources: string[] = [];
    let invalid = 0;
    for (const entry of entries) {
      if (!SOURCE_PATTERN.test(entry)) invalid += 1;
      else if (!sources.includes(entry)) sources.push(entry);
    }
    for (let i = 0; i < invalid; i += 1) {
      log(unavailableLine("invalid", CREDENTIAL_ROW_COUNT_INVALID_SOURCE));
    }
    if (sources.length === 0) return;

    let store: CredentialRowCounter | null = null;
    try {
      store = makeStore();
    } catch {
      store = null;
    }
    // Sequential: the store's lane serialises KV calls on the backend space anyway.
    for (const source of sources) {
      try {
        if (store === null) throw new Error("store unavailable");
        const count = await store.countRows(source);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid count");
        log(`credential_row_count source=${source} count=${count}`);
      } catch {
        log(unavailableLine(source, CREDENTIAL_ROW_COUNT_LIST_FAILED));
      }
    }
  } catch {
    // Diagnostics must never affect boot.
  }
}
