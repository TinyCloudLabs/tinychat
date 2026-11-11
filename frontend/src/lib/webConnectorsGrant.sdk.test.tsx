import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ConnectMeetingsLink } from "@/capture/home/desktop/ConnectMeetingsLink";
import { composeManifestRequest } from "@tinycloud/web-sdk";
import { NodeUserAuthorization } from "@tinycloud/node-sdk";
import { encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, restoreTinyCloudWebSession, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { HomeFeatureAccessContext, HomeFeatureGate, useHomeFeatureAccessState } from "@/shell/homeFeatureAccess";
import { homeFeaturesToRequest, readHomeFeatures, rememberHomeFeature, webSignInManifest, sessionCoversHomeFeature, type HomeFeature } from "./homeFeatures";
import { reauthorizeHome } from "./homeReauthorize";
import { webAppManifestFor } from "./webSignInPrefetch";

// Anvil's second default key: a well-known test key, never a real account.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const base = webAppManifestFor(false);
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
  const tcw = createTinyCloudWeb(wallet("approve"), { ...config, manifest: webSignInManifest(base, readHomeFeatures(localStorage, ADDRESS), ADDRESS) });
  await tcw.signIn();
  return tcw;
}

function reauthorize(features: readonly HomeFeature[], answer: "approve" | "decline" = "approve") {
  return reauthorizeHome({
    connect: async () => ({ address: ADDRESS, openkey: {} as never, web3Provider: wallet(answer) }),
    prefetch: { manifest: async () => base, nonceForSigning: async () => "webReauthTest1", guardSigning: (provider) => provider, complete: () => {}, cancel: () => {} },
    createTcw: createTinyCloudWeb,
    verify: async () => ({ token: "bearer", expiresIn: 3600 }),
  }, { address: ADDRESS, features, homeSite: false, config, canCommit: () => null });
}

/** Restore against the shipped full web manifest, as App does. */
async function reload(): Promise<TinyCloudWeb> {
  const restored = await restoreTinyCloudWebSession(ADDRESS, { ...config, manifest: webSignInManifest(base, [], ADDRESS) });
  expect(restored.status).toBe("restored");
  return restored.tcw!;
}

test("a new web account has no decrypt grant, while a device that used Connectors includes it", () => {
  expect(webSignInManifest(base, [], ADDRESS)).toEqual({ ...base, secrets: {} });
  expect(base.permissions?.some((entry) => entry.service === "tinycloud.encryption")).toBe(false);
  expect(webSignInManifest(base, ["recording"], ADDRESS)).toEqual({ ...base, secrets: {} });
  expect(rememberHomeFeature(localStorage, ADDRESS, "connectors")).toBe(true);
  const manifest = webSignInManifest(base, readHomeFeatures(localStorage, ADDRESS.toLowerCase()), ADDRESS);
  expect(manifest.permissions?.filter((entry) => entry.service === "tinycloud.encryption")).toHaveLength(1);
  expect(readHomeFeatures(localStorage, "0x00000000000000000000000000000000000000a1")).toEqual([]);
  expect(base.secrets).not.toHaveProperty("ASSEMBLYAI_API_KEY");
});

test("web Connectors first use shows the existing prompt and Continue obtains a signed grant that survives reload", async () => {
  const initial = await signInBase();
  expect(sessionCoversHomeFeature(initial, "connectors", ADDRESS)).toBe(false);
  let current = initial;
  let access: ReturnType<typeof useHomeFeatureAccessState>;
  let asked = 0;
  let firstUseReads = 0;
  function Page() {
    const [tcw, setTcw] = useState(initial);
    access = useHomeFeatureAccessState({
      homeSite: false, webConnectors: true,
      tcw: {
        hasPermissions: (entries) => tcw.hasPermissions(entries),
        kv: { get: async () => { firstUseReads++; return { ok: false, error: { code: "KV_NOT_FOUND" } }; } } as unknown as TinyCloudWeb["kv"],
      },
      address: ADDRESS, store: localStorage, inFlight: null,
      requestFeatureAccess: async (feature) => {
        asked++;
        const result = await reauthorize(homeFeaturesToRequest(localStorage, tcw, ADDRESS, feature));
        if (result.outcome === "granted") { current = result.tcw; setTcw(result.tcw); }
        return result.outcome;
      },
    });
    return <HomeFeatureAccessContext.Provider value={access}>
      <HomeFeatureGate feature="connectors"><div data-testid="connectors-screen" /></HomeFeatureGate>
    </HomeFeatureAccessContext.Provider>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Page />));
    expect(host.textContent).toContain("Allow Connectors");
    expect(host.textContent).toContain("OpenKey");
    expect(host.querySelector('[data-testid="connectors-screen"]')).toBeNull();
    expect(firstUseReads).toBe(0);
    expect(access!.covered("recording")).toBe(true);
    await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
    expect(asked).toBe(1);
    expect(host.querySelector('[data-testid="feature-access-connectors"]')).toBeNull();
    expect(host.querySelector('[data-testid="connectors-screen"]')).toBeTruthy();
    expect(sessionCoversHomeFeature(current, "connectors", ADDRESS)).toBe(true);
    expect(firstUseReads).toBe(1);
    expect(readHomeFeatures(localStorage, ADDRESS)).toEqual(["connectors"]);
    const restored = await reload();
    expect(sessionCoversHomeFeature(restored, "connectors", ADDRESS)).toBe(true);
    expect(restored.hasPermissions([{ service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/canvas", skipPrefix: true, actions: ["read", "write", "schema"] }])).toBe(true);
    restored.cleanup();
  } finally {
    await act(async () => root.unmount());
    initial.cleanup();
    current.cleanup();
  }
}, 30_000);

test("declining a web step-up keeps the persisted session and chat grant", async () => {
  const initial = await signInBase();
  const before = new Map(data);
  expect((await reauthorize(["connectors"], "decline")).outcome).toBe("declined");
  expect(data).toEqual(before);
  const restored = await reload();
  expect(sessionCoversHomeFeature(restored, "connectors", ADDRESS)).toBe(false);
  expect(restored.hasPermissions([{ service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/threads", skipPrefix: true, actions: ["read"] }])).toBe(true);
  initial.cleanup();
  restored.cleanup();
}, 30_000);

test("an existing full session with decrypt restores even without a device feature record", async () => {
  const tcw = createTinyCloudWeb(wallet("approve"), { ...config, manifest: webSignInManifest(base, ["connectors"], ADDRESS) });
  await tcw.signIn();
  expect(readHomeFeatures(localStorage, ADDRESS)).toEqual([]);
  const restored = await reload();
  expect(sessionCoversHomeFeature(restored, "connectors", ADDRESS)).toBe(true);
  tcw.cleanup();
  restored.cleanup();
}, 30_000);

test("Capture's Connect meetings entry opens the same permission surface before reading connector state", async () => {
  const initial = await signInBase();
  function Page() {
    const location = useLocation();
    const access = useHomeFeatureAccessState({
      homeSite: false, webConnectors: true, tcw: initial, address: ADDRESS,
      store: localStorage, inFlight: null, requestFeatureAccess: async () => "failed",
    });
    return <HomeFeatureAccessContext.Provider value={access}>
      <span data-testid="location">{location.pathname}</span>
      <ConnectMeetingsLink tcw={initial} backendUrl="" sessionStore={{} as never} />
    </HomeFeatureAccessContext.Provider>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/chat/capture"]}><Page /></MemoryRouter>));
    expect(host.querySelector('[data-testid="capture-connect-meetings"]')).toBeTruthy();
    expect(readHomeFeatures(localStorage, ADDRESS)).toEqual([]);
    await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe("/chat/connectors");
  } finally {
    await act(async () => root.unmount());
    initial.cleanup();
  }
}, 30_000);


test("web sign-in mirrors Home's secret KV and default-network abilities for unused and used Connectors", () => {
  for (const used of [false, true]) {
    const manifest = webSignInManifest(base, used ? ["connectors"] : [], ADDRESS);
    const resources = composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources;
    const secrets = resources.filter((entry) => entry.space === "secrets" && entry.service === "tinycloud.kv");
    expect(secrets.map((entry) => entry.path).sort()).toEqual(used ? [
      "vault/secrets/FIREFLIES_API_KEY", "vault/secrets/GRANOLA_API_KEY", "vault/secrets/scoped/google-meet/REFRESH_TOKEN",
    ] : []);
    for (const entry of secrets) expect(entry.actions).toEqual(["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"]);
    const authorization = new NodeUserAuthorization({
      manifest, includeAccountRegistryPermissions: false, domain: "tinycloud.chat", sessionManager: {}, wasmBindings: {},
    } as unknown as ConstructorParameters<typeof NodeUserAuthorization>[0]);
    const capabilities = (authorization as unknown as { resolveSignInCapabilities(address: string, chainId: number): {
      rawAbilities?: Record<string, string[]>;
    } }).resolveSignInCapabilities(ADDRESS, 1);
    expect(capabilities.rawAbilities ?? {}).toEqual(used ? {
      [encryptionDecryptGrant(ADDRESS).path]: ["tinycloud.encryption/decrypt", "tinycloud.encryption/network.create"],
    } : {});
  }
});

test("a newly signed non-Connectors web session reloads with its reduced base request", async () => {
  const initial = await signInBase();
  const saved = new Map(data);
  const restored = await reload();
  expect(data).toEqual(saved);
  expect(sessionCoversHomeFeature(restored, "connectors", ADDRESS)).toBe(false);
  expect(restored.hasPermissions([{ service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/threads", skipPrefix: true, actions: ["read"] }])).toBe(true);
  initial.cleanup();
  restored.cleanup();
}, 30_000);
