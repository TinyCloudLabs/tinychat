// The real web SDK (its WASM, SIWE and session storage) as the phone uses it, and the SDK decides third-party from
// `window.location.origin`. For an owner with no TinyCloud account record the refusal comes at sign-in, as
// AccountSetupRequiredError; a session restored at the phone's origin is not refused on its first request to the node, so
// `checkAccountSetup` returns. A local key stands in for OpenKey at the first sign-in; the node is a stub.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createTinyCloudWeb, restoreTinyCloudWebSession, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "./homeFeatures";
import { readOnlyAccountProvider } from "./replication/readOnlyAccountProvider";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";
import { checkAccountSetup, isAccountSetupRequired } from "./accountSetup";

// Anvil's fourth default key: a well-known test key, never a real account. The registry has no record for it.
const account = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const config = { autoCreateSpace: false, includeAccountRegistryPermissions: false as const, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST };
const manifest = webSignInManifest(WEB_APP_MANIFEST, [], ADDRESS);

let restoreDom: () => void;
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.pathname.includes("/locations/")) return Response.json({ error: "location record not found" }, { status: 404 });
    return new Response(
      url.pathname.endsWith("/info") ? JSON.stringify({ protocol: 1, version: "test", nodeId: "did:key:z6MkvSbonMn1Xgewrb4EsbjTmvMT8T9Y3PTb5PcnQcQUbzjc" }) : "{}",
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  restoreDom = installDom();
  atOrigin();
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
    clear: () => data.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});
afterEach(() => { restoreDom(); Reflect.deleteProperty(globalThis, "localStorage"); });

const wallet = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [ADDRESS];
    if (method === "eth_chainId") return "0x1";
    if (method === "personal_sign") {
      const message = String(params![0]);
      return account.signMessage({ message: message.startsWith("0x") ? { raw: message as `0x${string}` } : message });
    }
    throw new Error(`unsupported ${method}`);
  },
} as EIP1193Provider;

/** A session exists in storage (made on a first-party page); the phone then restores it at its own origin. */
async function restoredAt(origin: string) {
  await createTinyCloudWeb(wallet, { ...config, manifest }).signIn();
  atOrigin(origin);
  const restored = await restoreTinyCloudWebSession(ADDRESS, { ...config, manifest, provider: readOnlyAccountProvider(ADDRESS) });
  expect(restored.status).toBe("restored");
  return restored.tcw!;
}

for (const origin of ["https://localhost", "capacitor://localhost"]) {
  test(`a restored session's first node request is not refused on the phone origin ${origin}`, async () => {
    await expect(checkAccountSetup(await restoredAt(origin))).resolves.toBeUndefined();
  });

  test(`an owner with no account record is refused at sign-in on the phone origin ${origin}`, async () => {
    atOrigin(origin);
    const refusal = await createTinyCloudWeb(wallet, { ...config, manifest }).signIn().then(() => null, (caught: unknown) => caught);
    expect(isAccountSetupRequired(refusal)).toBe(true);
  });
}

test("the same owner passes the check on a first-party origin", async () => {
  await expect(checkAccountSetup(await restoredAt("https://app.tinycloud.one"))).resolves.toBeUndefined();
});
