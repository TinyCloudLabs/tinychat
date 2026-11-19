// What the real web SDK (its WASM, SIWE and session storage) asks the restore's read-only provider for. The provider
// answers a fixed chain; this holds only while a restored client never asks for the wallet's chain and takes the
// chain from its saved session instead.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createTinyCloudWeb, restoreTinyCloudWebSession, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "@/lib/homeFeatures";
import { WEB_APP_MANIFEST } from "@/lib/webSignInPrefetch";
import { readOnlyAccountProvider } from "./readOnlyAccountProvider";

// Anvil's second default key: a well-known test key, never a real account.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
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

/** OpenKey at sign-in, as far as the SDK can tell: it signs the SIWE it is shown. */
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

test("a restored client takes its chain from the saved session and never asks the provider for one", async () => {
  await createTinyCloudWeb(wallet, { ...config, manifest }).signIn();
  const asked: string[] = [];
  const provider = readOnlyAccountProvider(ADDRESS);
  const recording: EIP1193Provider = {
    ...provider,
    // A chain other than the session's: if the SDK took the provider's chain, the restored session would show it.
    request: async (args) => { asked.push(args.method); return args.method === "eth_chainId" ? "0x89" : provider.request(args); },
  };
  const restored = await restoreTinyCloudWebSession(ADDRESS, { ...config, manifest, provider: recording });
  expect(restored.status).toBe("restored");
  expect(restored.tcw!.session()?.chainId).toBe(1);
  expect(asked).not.toContain("eth_chainId");
});
