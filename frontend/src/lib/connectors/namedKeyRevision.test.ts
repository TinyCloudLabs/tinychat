import { describe, expect, test } from "bun:test";
import manifest from "../../../../manifest.json";
import { applyConnectorKeyRevisionGate, manifestCarriesConnectorKey, recordConnectorKeyRevision } from "./namedKeyRevision";

const address = "0x00000000000000000000000000000000000000Aa";

function store() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("connector key sign-in revision", () => {
  test("requires the exact host-bound key grant", () => {
    expect(manifestCarriesConnectorKey(manifest)).toBe(true);
    expect(manifestCarriesConnectorKey({ ...manifest, keys: [{ prefix: "apps/other/", abilities: ["key.create", "decrypt"] }] })).toBe(false);
  });

  test("a prior session is cleared only after the served manifest carries the key grant", async () => {
    const memory = store();
    const cleared: string[] = [];
    const input = {
      store: memory, address, isOffline: () => false,
      loadManifest: async (): Promise<unknown> => ({ ...manifest, keys: [] }),
      handoff: async () => true, clearSession: (owner: string) => { cleared.push(owner); },
    };
    expect(await applyConnectorKeyRevisionGate(input)).toBe("deferred");
    expect(cleared).toEqual([]);
    expect(await applyConnectorKeyRevisionGate({ ...input, loadManifest: async () => manifest })).toBe("cleared");
    expect(cleared).toEqual([address]);
  });

  test("a newly signed session records the grant and restores without another clearance", async () => {
    const memory = store();
    recordConnectorKeyRevision(memory, address, manifest);
    let fetches = 0;
    const outcome = await applyConnectorKeyRevisionGate({
      store: memory, address, isOffline: () => false,
      loadManifest: async () => { fetches++; return manifest; },
      handoff: async () => true, clearSession: () => { throw new Error("unexpected clearance"); },
    });
    expect(outcome).toBe("current");
    expect(fetches).toBe(0);
  });
});
