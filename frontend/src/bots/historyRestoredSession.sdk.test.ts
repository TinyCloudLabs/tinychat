// A page reload against the real web SDK (its WASM, SIWE and session storage), with a local key standing in for
// OpenKey and a stub node: what Main's history code finds on the restored client. TC-3019: without the restore's
// read-only provider the restored client reported no session, so opening Main failed with history_session_missing.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, restoreTinyCloudWebSession, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { webSignInManifest } from "@/lib/homeFeatures";
import { readOnlyAccountProvider } from "@/lib/replication/readOnlyAccountProvider";
import { WEB_APP_MANIFEST } from "@/lib/webSignInPrefetch";
import { authorizeBotHistory } from "./historyAuthorization";

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

/** OpenKey, as far as the SDK can tell at sign-in: it signs the SIWE it is shown. */
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

/** Sign in, then reload the way App's web restore does. */
async function signInThenReload(): Promise<{ signedIn: TinyCloudWeb; restored: TinyCloudWeb }> {
  const signedIn = createTinyCloudWeb(wallet, { ...config, manifest });
  await signedIn.signIn();
  const restored = await restoreTinyCloudWebSession(ADDRESS, { ...config, manifest, provider: readOnlyAccountProvider(ADDRESS) });
  expect(restored.status).toBe("restored");
  return { signedIn, restored: restored.tcw! };
}

test("the restored client reports the signed-in session: the same account, chain and signed SIWE", async () => {
  const { signedIn, restored } = await signInThenReload();
  const before = signedIn.session()!;
  expect(restored.session()).toMatchObject({ address: before.address, chainId: 1, siwe: before.siwe, signature: before.signature });
  expect(restored.chainId()).toBe(1);
});

test("opening Main after a reload reaches the owner's approval instead of failing on a missing session", async () => {
  const { restored } = await signInThenReload();
  const connected: string[] = [];
  const failure = await authorizeBotHistory(
    restored,
    async () => { connected.push("openkey"); throw new Error("owner_approval_reached"); },
    async () => ({ enabled: true }),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("owner_approval_reached");
  expect(connected).toEqual(["openkey"]);
});
