// The in-place re-authorise against the real web SDK (its WASM, SIWE ReCap and session storage), with a local key
// standing in for OpenKey and a stub node answering /info. What each test checks is what the session's own signed
// approval covers after the swap and after a reload, which is what decides whether Connectors shows a prompt.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, restoreTinyCloudWebSession, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { HomeFeatureAccessContext, HomeFeatureGate, useHomeFeatureAccessState } from "@/shell/homeFeatureAccess";
import { homeFeaturesToRequest, sessionCoversHomeFeature, webSignInManifest, type HomeFeature } from "./homeFeatures";
import { reauthorizeHome } from "./homeReauthorize";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

// Anvil's second default key: a well-known test key, never a real account.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const base = WEB_APP_MANIFEST;
const config = { autoCreateSpace: false, includeAccountRegistryPermissions: false as const, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST };

let restoreDom: () => void;
let data: Map<string, string>;
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if ((init?.method ?? "GET") === "GET" && url.origin === HOST && (
      path === "/v2/locations/" + ADDRESS.toLowerCase() ||
      path === "/v1/locations/did:pkh:eip155:1:" + ADDRESS.toLowerCase()
    )) return Response.json({ error: "location record not found" }, { status: 404 });
    return new Response(
      String(input).endsWith("/info") ? JSON.stringify({ protocol: 1, version: "test", nodeId: "did:key:z6MkvSbonMn1Xgewrb4EsbjTmvMT8T9Y3PTb5PcnQcQUbzjc" }) : "{}",
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  restoreDom = installDom();
  data = new Map();
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

/** OpenKey, as far as the SDK can tell: it signs the SIWE it is shown, or the owner closes it. */
function wallet(answer: "approve" | "decline"): EIP1193Provider {
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [ADDRESS];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        if (answer === "decline") throw { code: "USER_CANCELLED" };
        const message = String(params![0]);
        return account.signMessage({ message: message.startsWith("0x") ? { raw: message as `0x${string}` } : message });
      }
      throw new Error(`unsupported ${method}`);
    },
  } as EIP1193Provider;
}

async function signInBase(): Promise<TinyCloudWeb> {
  const tcw = createTinyCloudWeb(wallet("approve"), { ...config, manifest: webSignInManifest(base, [], ADDRESS) });
  await tcw.signIn();
  return tcw;
}

function reauthorize(features: readonly HomeFeature[], answer: "approve" | "decline" = "approve") {
  return reauthorizeHome({
    connect: async () => ({ address: ADDRESS, openkey: {} as never, web3Provider: wallet(answer) }),
    prefetch: { manifest: async () => base, nonceForSigning: async () => "homeReauthTest1", guardSigning: (provider) => provider, complete: () => {}, cancel: () => {} },
    createTcw: createTinyCloudWeb,
    verify: async () => ({ token: "bearer", expiresIn: 3600 }),
  }, { address: ADDRESS, features, config, canCommit: () => null });
}

/** A page reload: a new instance restores the saved session under the fresh web sign-in grant, as App's restore does. */
async function reload(): Promise<TinyCloudWeb> {
  const restored = await restoreTinyCloudWebSession(ADDRESS, { ...config, manifest: webSignInManifest(base, [], ADDRESS) });
  expect(restored.status).toBe("restored");
  return restored.tcw!;
}

test("a reload after granting Connectors restores a session whose own approval covers it, and Connectors opens without a prompt", async () => {
  await signInBase();
  expect(sessionCoversHomeFeature(await reload(), "connectors", ADDRESS)).toBe(false);

  const result = await reauthorize(["connectors"]);
  expect(result.outcome).toBe("granted");
  const restored = await reload();
  expect(sessionCoversHomeFeature(restored, "connectors", ADDRESS)).toBe(true);

  function Page() {
    const access = useHomeFeatureAccessState({
      enabled: true, tcw: restored, address: ADDRESS, store: localStorage, requestFeatureAccess: async () => "failed", inFlight: null,
    });
    return (
      <HomeFeatureAccessContext.Provider value={access}>
        <HomeFeatureGate feature="connectors"><div data-testid="connectors-screen" /></HomeFeatureGate>
      </HomeFeatureAccessContext.Provider>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Page />));
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-connectors"]')).toBeNull();
  await act(async () => root.unmount());
}, 30_000);

test("asking again on a session that already covers Connectors keeps it covered", async () => {
  await signInBase();
  const first = await reauthorize(["connectors"]);
  if (first.outcome !== "granted") throw new Error(first.outcome);
  const features = homeFeaturesToRequest(localStorage, first.tcw, ADDRESS, "connectors");
  expect(features).toEqual(["connectors"]);
  const second = await reauthorize(features);
  if (second.outcome !== "granted") throw new Error(second.outcome);
  for (const tcw of [second.tcw, await reload()]) {
    expect(sessionCoversHomeFeature(tcw, "connectors", ADDRESS)).toBe(true);
  }
}, 30_000);

test("declining in OpenKey keeps the saved session: a reload restores it, with the base grant only", async () => {
  await signInBase();
  expect((await reauthorize(["connectors"], "decline")).outcome).toBe("declined");
  const restored = await reload();
  expect(sessionCoversHomeFeature(restored, "connectors", ADDRESS)).toBe(false);
  expect(restored.hasPermissions([{ service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/threads", actions: ["read"], skipPrefix: true }])).toBe(true);
}, 30_000);
