import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { saveConnectorKey } from "./connectorSecrets";
import { NAMED_KEY_WRITES_RUNTIME_FLAG_KEY, connectorNamedKeyWritesEnabled } from "./namedKeyWrites";

type PutCall = { name: string; value: string; options: unknown };

function fakeTcw(results: Array<{ ok: true } | { ok: false; error: unknown }>) {
  const calls: PutCall[] = [];
  const tcw = {
    secrets: {
      put: async (name: string, value: string, options?: unknown) => {
        calls.push({ name, value, options });
        return results.shift() ?? { ok: true };
      },
    },
    ensureOwnedSpaceHosted: async () => {},
  } as unknown as TinyCloudWeb;
  return { tcw, calls };
}

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
function setRuntimeFlag(value: string | null) {
  const data = new Map<string, string>(value === null ? [] : [[NAMED_KEY_WRITES_RUNTIME_FLAG_KEY, value]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: { getItem: (key: string) => data.get(key) ?? null },
  });
}
beforeEach(() => setRuntimeFlag(null));
afterEach(() => {
  if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the named-key write switch", () => {
  test("is off with no build flag and no runtime flag", () => {
    expect(connectorNamedKeyWritesEnabled({}, null)).toBe(false);
    expect(connectorNamedKeyWritesEnabled({}, { getItem: () => null })).toBe(false);
  });

  test("turns on only for the exact string true, from the build or from this browser", () => {
    expect(connectorNamedKeyWritesEnabled({ VITE_CONNECTOR_NAMED_KEY_WRITES: "true" }, null)).toBe(true);
    expect(connectorNamedKeyWritesEnabled({}, { getItem: () => "true" })).toBe(true);
    for (const other of ["1", "TRUE", "yes", "false", ""]) {
      expect(connectorNamedKeyWritesEnabled({ VITE_CONNECTOR_NAMED_KEY_WRITES: other }, { getItem: () => other })).toBe(false);
    }
  });

  test("blocked storage leaves it off", () => {
    expect(connectorNamedKeyWritesEnabled({}, { getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});

describe("saveConnectorKey with the switch off (the default)", () => {
  test("a plain secret is put with no options, as before", async () => {
    const { tcw, calls } = fakeTcw([]);
    const result = await saveConnectorKey(tcw, { secretName: "FIREFLIES_API_KEY" }, "k1");
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ name: "FIREFLIES_API_KEY", value: "k1", options: undefined }]);
  });

  test("a scoped secret is put with its scope only", async () => {
    const { tcw, calls } = fakeTcw([]);
    await saveConnectorKey(tcw, { secretName: "REFRESH_TOKEN", secretScope: "google-meet" }, "t1");
    expect(calls).toEqual([{ name: "REFRESH_TOKEN", value: "t1", options: { scope: "google-meet" } }]);
  });
});

describe("saveConnectorKey with the switch on", () => {
  test("a plain secret is put with namedKey on", async () => {
    setRuntimeFlag("true");
    const { tcw, calls } = fakeTcw([]);
    const result = await saveConnectorKey(tcw, { secretName: "FIREFLIES_API_KEY" }, "k1");
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ name: "FIREFLIES_API_KEY", value: "k1", options: { namedKey: true } }]);
  });

  test("a scoped secret keeps its scope and also asks for namedKey", async () => {
    setRuntimeFlag("true");
    const { tcw, calls } = fakeTcw([]);
    await saveConnectorKey(tcw, { secretName: "REFRESH_TOKEN", secretScope: "google-meet" }, "t1");
    expect(calls).toEqual([{ name: "REFRESH_TOKEN", value: "t1", options: { scope: "google-meet", namedKey: true } }]);
  });

  test("the retry after the space is hosted uses the same options", async () => {
    setRuntimeFlag("true");
    const { tcw, calls } = fakeTcw([{ ok: false, error: { code: "KV_NOT_FOUND" } }, { ok: true }]);
    const result = await saveConnectorKey(tcw, { secretName: "GRANOLA_API_KEY" }, "g1");
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.options)).toEqual([{ namedKey: true }, { namedKey: true }]);
  });
});
