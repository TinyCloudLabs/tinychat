/** localStorage is shared across tabs; the fallback also fences non-browser test environments. */
export function localDataEpoch(key: string) {
  let fallback = "initial";
  return {
    read(): string {
      try { return globalThis.localStorage?.getItem(key) ?? fallback; }
      catch { return fallback; }
    },
    advance(): void {
      fallback = crypto.randomUUID();
      try { globalThis.localStorage?.setItem(key, fallback); } catch { /* In-memory fencing still works. */ }
    },
  };
}
