// The in-place re-authorise against the real web SDK (its WASM, SIWE ReCap and session storage), with a local key
// standing in for OpenKey and a stub node answering /info. What each test checks is what the session's own signed
// approval covers after the swap and after a reload, which is what decides whether Home shows a prompt.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, restoreTinyCloudWebSession, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { HomeFeatureAccessContext, HomeFeatureGate, useHomeFeatureAccessState } from "@/shell/homeFeatureAccess";
import { homeFeaturesToRequest, sessionCoversHomeFeature, type HomeFeature } from "./homeFeatures";
import { reauthorizeHome } from "./homeReauthorize";
import { webAppManifestFor } from "./webSignInPrefetch";

// Anvil's second default key: a well-known test key, never a real account.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const base = webAppManifestFor(true);
const config = { autoCreateSpace: false, includeAccountRegistryPermissions: false as const, tinycloudHosts: [HOST] };

let restoreDom: () => void;
let data: Map<string, string>;
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(
    String(input).endsWith("/info") ? JSON.stringify({ protocol: 1, version: "test" }) : "{}",
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
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
  const tcw = createTinyCloudWeb(wallet("approve"), { ...config, manifest: base });
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

/** A page reload: a new instance restores the saved session under the Home base grant, as App's restore does. */
async function reload(): Promise<TinyCloudWeb> {
  const restored = await restoreTinyCloudWebSession(ADDRESS, { ...config, manifest: base });
  expect(restored.status).toBe("restored");
  return restored.tcw!;
}

test("a reload after granting Recording restores a session whose own approval covers it, and Recording opens without a prompt", async () => {
  await signInBase();
  expect(sessionCoversHomeFeature(await reload(), "recording", ADDRESS)).toBe(false);

  const result = await reauthorize(["recording"]);
  expect(result.outcome).toBe("granted");
  const restored = await reload();
  expect(sessionCoversHomeFeature(restored, "recording", ADDRESS)).toBe(true);
  expect(sessionCoversHomeFeature(restored, "connectors", ADDRESS)).toBe(false);

  function Page() {
    const access = useHomeFeatureAccessState({
      homeSite: true, tcw: restored, address: ADDRESS, store: localStorage, requestFeatureAccess: async () => "failed", inFlight: null,
    });
    return (
      <HomeFeatureAccessContext.Provider value={access}>
        <HomeFeatureGate feature="recording"><div data-testid="recording-screen" /></HomeFeatureGate>
      </HomeFeatureAccessContext.Provider>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Page />));
  expect(host.querySelector('[data-testid="recording-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-recording"]')).toBeNull();
  await act(async () => root.unmount());
}, 30_000);

test("with Recording covered but not yet flagged, allowing Connectors keeps Recording: the new session covers both", async () => {
  await signInBase();
  const first = await reauthorize(["recording"]);
  if (first.outcome !== "granted") throw new Error(first.outcome);
  // Nothing has used Recording yet, so the device flag is empty; the session still covers it.
  const features = homeFeaturesToRequest(localStorage, first.tcw, ADDRESS, "connectors");
  expect(features).toEqual(["recording", "connectors"]);
  const second = await reauthorize(features);
  if (second.outcome !== "granted") throw new Error(second.outcome);
  for (const tcw of [second.tcw, await reload()]) {
    expect(sessionCoversHomeFeature(tcw, "recording", ADDRESS)).toBe(true);
    expect(sessionCoversHomeFeature(tcw, "connectors", ADDRESS)).toBe(true);
  }
}, 30_000);

test("declining in OpenKey keeps the saved session: a reload restores it, with the base grant only", async () => {
  await signInBase();
  expect((await reauthorize(["recording"], "decline")).outcome).toBe("declined");
  const restored = await reload();
  expect(sessionCoversHomeFeature(restored, "recording", ADDRESS)).toBe(false);
  expect(restored.hasPermissions([{ service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/threads", actions: ["read"], skipPrefix: true }])).toBe(true);
}, 30_000);
