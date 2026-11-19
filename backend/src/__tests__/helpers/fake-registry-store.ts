import type { RegistryKv } from "../../bots-registry.js";

export interface FakeRegistryRow {
  value: string;
  version: number;
}

/**
 * The backend's own store for tests: honours `ifMatch` and `ifNoneMatch` with the SDK's result envelopes. Several
 * registries can share one, as two backend processes share one space.
 */
export interface FakeRegistryStore extends RegistryKv {
  rows: Map<string, FakeRegistryRow>;
  /** Runs once, inside the next put, before its condition is checked. */
  beforePut: undefined | (() => Promise<void>);
  /** When set, every read fails as if the store were unreachable. */
  down: boolean;
}

export function fakeRegistryStore(): FakeRegistryStore {
  const rows = new Map<string, FakeRegistryRow>();
  const precondition = { ok: false, error: { code: "KV_PRECONDITION_FAILED", service: "kv", message: "precondition failed" } };
  const kv: FakeRegistryStore = {
    rows,
    beforePut: undefined,
    down: false,
    async get(key) {
      if (kv.down) throw new Error("store down");
      const row = rows.get(key);
      if (!row) return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      return { ok: true, data: { data: row.value, headers: { etag: `"${row.version}"` } } };
    },
    async put(key, value, options) {
      const hook = kv.beforePut;
      kv.beforePut = undefined;
      if (hook) await hook();
      const row = rows.get(key);
      if (options.ifNoneMatch === "*" && row) return precondition;
      if (options.ifMatch !== undefined && (!row || `"${row.version}"` !== options.ifMatch)) return precondition;
      rows.set(key, { value: JSON.stringify(value), version: (row?.version ?? 0) + 1 });
      return { ok: true };
    },
  };
  return kv;
}
