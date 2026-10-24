import { describe, expect, it } from "bun:test";
import {
  NODE_HOST_STORAGE_KEY,
  clearNodeHost,
  clearNodePin,
  isLocalNodeHost,
  isNodeDid,
  parseLoopbackNodeAddress,
  readNodePin,
  resolveNodeHosts,
  saveNodeHost,
  writeNodePin,
} from "./nodeHost";

const ID_A = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN1";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe("parseLoopbackNodeAddress", () => {
  const accepted: [string, string][] = [
    ["http://127.0.0.1:8000", "http://127.0.0.1:8000"],
    ["  http://127.0.0.1:8000/ ", "http://127.0.0.1:8000"],
    ["HTTP://127.0.0.1:65535", "http://127.0.0.1:65535"],
    ["http://127.0.0.1:0080", "http://127.0.0.1:80"],
  ];
  for (const [input, normalized] of accepted) {
    it(`accepts ${JSON.stringify(input)} as ${normalized}`, () => expect(parseLoopbackNodeAddress(input)).toBe(normalized));
  }
  const refused = [
    "", "127.0.0.1:8000", "http://127.0.0.1", "http://127.0.0.1:", "http://127.0.0.1:0", "http://127.0.0.1:65536",
    "http://localhost:8000", "http://[::1]:8000", "http://127.0.0.2:8000", "http://0.0.0.0:8000",
    "https://127.0.0.1:8000", "https://tee.node.tinycloud.xyz", "https://example.com", "http://example.com:8000",
    "http://127.0.0.1:8000/path", "http://127.0.0.1:8000?x=1", "http://127.0.0.1:8000#x", "http://user@127.0.0.1:8000",
    "http://127.0.0.1:8000@evil.example", "http://127.0.0.1.evil.example:8000", "http://127.0.0.1:8000 http://evil.example",
    "javascript:alert(1)", "http://127.0.0.1:-1", "http://127.0.0.1:80.5",
  ];
  for (const input of refused) {
    it(`refuses ${JSON.stringify(input)}`, () => expect(parseLoopbackNodeAddress(input)).toBeNull());
  }
});

describe("isLocalNodeHost", () => {
  it("is true only for a normalized loopback address", () => {
    expect(isLocalNodeHost("http://127.0.0.1:8000")).toBe(true);
    expect(isLocalNodeHost("http://127.0.0.1:8000/")).toBe(false);
    expect(isLocalNodeHost("https://tee.node.tinycloud.xyz")).toBe(false);
    expect(isLocalNodeHost(undefined)).toBe(false);
  });
});

describe("resolveNodeHosts", () => {
  const build = { VITE_TINYCLOUD_HOST: "https://build.example" };
  const table: { name: string; saved: string | null; platform: "tauri" | "web" | "ios" | "android"; env: { VITE_TINYCLOUD_HOST?: string }; hosts: string[]; kept: boolean }[] = [
    { name: "nothing saved, no build host: the SDK default", saved: null, platform: "tauri", env: {}, hosts: [], kept: false },
    { name: "nothing saved, build host: the build host", saved: null, platform: "tauri", env: build, hosts: ["https://build.example"], kept: false },
    { name: "a saved local address on the desktop app", saved: "http://127.0.0.1:8000", platform: "tauri", env: build, hosts: ["http://127.0.0.1:8000"], kept: true },
    { name: "a saved local address is ignored on the web", saved: "http://127.0.0.1:8000", platform: "web", env: build, hosts: ["https://build.example"], kept: true },
    { name: "a saved local address is ignored on iOS", saved: "http://127.0.0.1:8000", platform: "ios", env: {}, hosts: [], kept: true },
    { name: "a saved local address is ignored on Android", saved: "http://127.0.0.1:8000", platform: "android", env: {}, hosts: [], kept: true },
    { name: "a saved hosted address is refused and cleared", saved: "https://evil.example", platform: "tauri", env: build, hosts: ["https://build.example"], kept: false },
    { name: "a saved localhost address is refused and cleared", saved: "http://localhost:8000", platform: "tauri", env: {}, hosts: [], kept: false },
    { name: "a saved non-normalized address is refused and cleared", saved: "http://127.0.0.1:8000/", platform: "tauri", env: {}, hosts: [], kept: false },
    { name: "a saved empty value is refused and cleared", saved: "", platform: "tauri", env: {}, hosts: [], kept: false },
  ];
  for (const row of table) {
    it(row.name, () => {
      const storage = memoryStorage(row.saved === null ? {} : { [NODE_HOST_STORAGE_KEY]: row.saved });
      expect(resolveNodeHosts({ env: row.env, storage, platform: row.platform }).hosts).toEqual(row.hosts);
      expect(storage.data.has(NODE_HOST_STORAGE_KEY)).toBe(row.kept);
    });
  }

  it("reports the saved node ID for a local address", () => {
    const storage = memoryStorage();
    saveNodeHost("http://127.0.0.1:8000", storage);
    expect(resolveNodeHosts({ env: {}, storage, platform: "tauri" }).pinnedDid).toBeUndefined();
    writeNodePin("http://127.0.0.1:8000", ID_A, new Date("2026-10-24T01:02:03Z"), storage);
    expect(resolveNodeHosts({ env: {}, storage, platform: "tauri" })).toEqual({ hosts: ["http://127.0.0.1:8000"], pinnedDid: ID_A });
  });

  it("survives storage that throws", () => {
    const storage = { getItem: () => { throw new Error("denied"); }, setItem: () => {}, removeItem: () => {} };
    expect(resolveNodeHosts({ env: {}, storage, platform: "tauri" }).hosts).toEqual([]);
  });
});

describe("saving and clearing the address (Settings only)", () => {
  it("saves the normalized form and clears it", () => {
    const storage = memoryStorage();
    expect(saveNodeHost(" http://127.0.0.1:9000/ ", storage)).toBe(true);
    expect(storage.data.get(NODE_HOST_STORAGE_KEY)).toBe("http://127.0.0.1:9000");
    clearNodeHost(storage);
    expect(storage.data.has(NODE_HOST_STORAGE_KEY)).toBe(false);
  });

  it("writes nothing for an address that is not a loopback address", () => {
    const storage = memoryStorage();
    expect(saveNodeHost("https://evil.example", storage)).toBe(false);
    expect(saveNodeHost("http://localhost:8000", storage)).toBe(false);
    expect(storage.data.size).toBe(0);
  });
});

describe("the saved node ID", () => {
  const address = "http://127.0.0.1:8000";

  it("round-trips, keyed by the address", () => {
    const storage = memoryStorage();
    expect(writeNodePin(address, ID_A, new Date("2026-10-24T01:02:03Z"), storage)).toBe(true);
    expect([...storage.data.keys()]).toEqual([`xyz.tinycloud.tinychat:node-pin:${address}`]);
    expect(readNodePin(address, storage)).toEqual({ nodeId: ID_A, firstSeenAt: "2026-10-24T01:02:03.000Z" });
    expect(readNodePin("http://127.0.0.1:8001", storage)).toBeNull();
  });

  it("is never written for a hosted address or a value that is not a node ID", () => {
    const storage = memoryStorage();
    expect(writeNodePin("https://tee.node.tinycloud.xyz", ID_A, new Date(), storage)).toBe(false);
    expect(writeNodePin(address, "did:key:z6Mk", new Date(), storage)).toBe(false);
    expect(writeNodePin(address, "did:web:example.com", new Date(), storage)).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it("reads a damaged record as no saved ID", () => {
    for (const raw of ["not json", "null", "[]", JSON.stringify({ nodeId: "did:web:x", firstSeenAt: "t" }), JSON.stringify({ nodeId: ID_A })]) {
      const storage = memoryStorage({ [`xyz.tinycloud.tinychat:node-pin:${address}`]: raw });
      expect(readNodePin(address, storage)).toBeNull();
    }
  });

  it("is removed for that address only", () => {
    const storage = memoryStorage();
    writeNodePin(address, ID_A, new Date(), storage);
    writeNodePin("http://127.0.0.1:8001", ID_A, new Date(), storage);
    clearNodePin(address, storage);
    expect(readNodePin(address, storage)).toBeNull();
    expect(readNodePin("http://127.0.0.1:8001", storage)).not.toBeNull();
  });
});

describe("isNodeDid", () => {
  it("accepts an Ed25519 did:key and nothing else", () => {
    expect(isNodeDid(ID_A)).toBe(true);
    for (const value of [undefined, null, 5, "", "did:key:z6Mk", `${ID_A}0`, ID_A.slice(0, -1), ID_A.replace("did:key", "did:web"), ID_A.replace("z6Mk", "z6LS"), `${ID_A} `, ID_A.replace("sh", "0O")]) {
      expect(isNodeDid(value)).toBe(false);
    }
  });
});
