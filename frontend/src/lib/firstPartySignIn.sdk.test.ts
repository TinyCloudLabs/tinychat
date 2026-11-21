// Which origins TinyChat's web sign-in works on for an owner without a TinyCloud account record (js-sdk #945/#987).
// The real web SDK decides from `window.location.origin`: on TinyCloud's own origins such an owner signs in; anywhere
// else sign-in stops with AccountSetupRequiredError. If one of TinyChat's origins drops off the SDK's first-party
// list, its case here fails.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createTinyCloudWeb, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "./homeFeatures";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

// Anvil's third default key: a well-known test key, never a real account. The registry has no record for it.
const account = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
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

for (const [name, origin] of [
  ["tinycloud.chat", "https://tinycloud.chat"],
  ["TinyCloud One on the web", "https://tinycloud.one"],
  ["the Android app", "https://app.tinycloud.one"],
  ["the iOS app", "tinycloudone://app.tinycloud.one"],
] as const) {
  test(`an owner without a TinyCloud account signs in on ${name} (${origin})`, async () => {
    atOrigin(origin);
    const session = await createTinyCloudWeb(wallet, { ...config, manifest }).signIn();
    expect(session.address.toLowerCase()).toBe(ADDRESS.toLowerCase());
  });
}

for (const origin of ["https://example.com", "http://localhost:5186", "capacitor://localhost", "https://localhost"]) {
  test(`the same owner is sent to set up an account first on ${origin}`, async () => {
    atOrigin(origin);
    await expect(createTinyCloudWeb(wallet, { ...config, manifest }).signIn()).rejects.toMatchObject({
      code: "ACCOUNT_SETUP_REQUIRED",
      setupUrl: "https://home.tinycloud.xyz/",
    });
  });
}
