// What each TinyChat web flow asks OpenKey to sign, and what the resulting session may do, on the installed web SDK.
// __fixtures__/session-grants.beta26.json holds both as captured on web-sdk 3.12.0-beta.26 (production before the
// 3.12.0-beta.37 repin). Every flow must ask for the same thing in the same words, and the session must hold exactly
// the same resources and actions: nothing missing, nothing extra. Details: TC-3030
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { BrowserSessionStorage, TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, restoreTinyCloudWebSession, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "./homeFeatures";
import { reauthorizeHome } from "./homeReauthorize";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";
import { readOnlyAccountProvider } from "./replication/readOnlyAccountProvider";
import { AGENT_CONSENT_MANIFEST, MCP_CONSENT_MANIFEST, actionsFromAuthJwt, ephemeralAgentSdkConfig, mintAgentDelegation } from "./agentDelegation";
import production from "./__fixtures__/session-grants.beta26.json";

// Anvil's second default key: a well-known test key, never a real account. The fixture was captured with it.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const config = { autoCreateSpace: false, includeAccountRegistryPermissions: false as const, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST };
const base = WEB_APP_MANIFEST;
let signed: string[] = [];
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
  signed = [];
});
afterEach(() => { restoreDom(); Reflect.deleteProperty(globalThis, "localStorage"); });

/** OpenKey, as far as the SDK can tell: records the SIWE it is asked to sign (what the consent screen shows) and signs it. */
const wallet = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [ADDRESS];
    if (method === "eth_chainId") return "0x1";
    if (method === "personal_sign") {
      const raw = String(params![0]);
      const message = raw.startsWith("0x") ? Buffer.from(raw.slice(2), "hex").toString("utf8") : raw;
      signed.push(message);
      return account.signMessage({ message });
    }
    throw new Error(`unsupported ${method}`);
  },
} as EIP1193Provider;

/** The SIWE with its per-run lines masked. */
function consent(siwe: string): string {
  return siwe.split("\n").map((line) => line.replace(/^(URI|Nonce|Issued At|Expiration Time|Not Before|Request ID): .*$/, "$1: <masked>")).join("\n");
}

/** Each ReCap in the SIWE, decoded: resource -> sorted actions. */
function recaps(siwe: string) {
  return [...siwe.matchAll(/urn:recap:([A-Za-z0-9_-]+)/g)].map((match) => {
    const recap = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown>>; prf?: unknown[] };
    const att = Object.fromEntries(Object.entries(recap.att).sort(([a], [b]) => a.localeCompare(b))
      .map(([resource, actions]) => [resource, Object.keys(actions).sort()]));
    return { att, prf: recap.prf?.length ?? 0 };
  });
}

async function restore() {
  const restored = await restoreTinyCloudWebSession(ADDRESS, { ...config, manifest: webSignInManifest(base, [], ADDRESS), provider: readOnlyAccountProvider(ADDRESS) });
  expect(restored.status).toBe("restored");
  return restored.tcw!;
}

test("web sign-in and restore, before Connectors: the same consent and the same grant as production", async () => {
  const session = await createTinyCloudWeb(wallet, { ...config, manifest: webSignInManifest(base, [], ADDRESS) }).signIn();
  expect(signed.map(consent)).toEqual([production.signInBase.consent]);
  expect(recaps(session.siwe)).toEqual(production.signInBase.recaps);
  expect(recaps((await restore()).session()!.siwe)).toEqual(production.restoreBase.recaps);
});

test("web sign-in and restore, with Connectors: the same consent and the same grant as production", async () => {
  const session = await createTinyCloudWeb(wallet, { ...config, manifest: webSignInManifest(base, ["connectors"], ADDRESS) }).signIn();
  expect(signed.map(consent)).toEqual([production.signInConnectors.consent]);
  expect(recaps(session.siwe)).toEqual(production.signInConnectors.recaps);
  expect(recaps((await restore()).session()!.siwe)).toEqual(production.restoreConnectors.recaps);
});

test("the step-up to Connectors: granted, with the same consent and the same grant as production", async () => {
  await createTinyCloudWeb(wallet, { ...config, manifest: webSignInManifest(base, [], ADDRESS) }).signIn();
  signed = [];
  const result = await reauthorizeHome({
    connect: async () => ({ address: ADDRESS, openkey: {} as never, web3Provider: wallet }),
    prefetch: { manifest: async () => base, nonceForSigning: async () => "sessionGrantsNonce1", guardSigning: (provider) => provider, complete: () => {}, cancel: () => {} },
    createTcw: createTinyCloudWeb,
    verify: async () => ({ token: "bearer", expiresIn: 3600 }),
  }, { address: ADDRESS, features: ["connectors"], config, canCommit: () => null });
  expect(result.outcome).toBe("granted");
  expect(signed.map(consent)).toEqual([production.stepUpConnectors.consent]);
  if (result.outcome === "granted") expect(recaps(result.tcw.session()!.siwe)).toEqual(production.stepUpConnectors.recaps);
});

function consentSession(manifest: typeof AGENT_CONSENT_MANIFEST) {
  const memory = new Map<string, string>();
  const storage = {
    get length() { return memory.size; },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => { memory.delete(key); },
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
  } as Storage;
  // As mintAgentDelegationViaFreshSignIn builds it, against the test node.
  return new TinyCloudWeb({
    ...ephemeralAgentSdkConfig({ web3Provider: wallet as never, sessionStorage: new BrowserSessionStorage({ storage }), tinycloudHosts: [HOST], manifest }),
    tinycloudRegistryUrl: HOST, newUserHost: HOST, autoCreateSpace: false,
  } as ConstructorParameters<typeof TinyCloudWeb>[0]);
}

test("the private agent's consent: the same consent and grant as production, and its delegation carries capabilities/read", async () => {
  const tcw = consentSession(AGENT_CONSENT_MANIFEST);
  const session = await tcw.signIn();
  expect(signed.map(consent)).toEqual([production.agentConsent.consent]);
  expect(recaps(session.siwe)).toEqual(production.agentConsent.recaps);
  // The sub-delegation to the agent: a session-key UCAN whose signed actions include tinycloud.capabilities/read.
  const delegation = JSON.parse(await mintAgentDelegation(tcw, { host: HOST })) as { delegationHeader: { Authorization: string } };
  // A signed JWT, not a wallet-signed CACAO: the agent accepts only the former.
  expect(delegation.delegationHeader.Authorization).toMatch(/^(Bearer )?[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(actionsFromAuthJwt(delegation.delegationHeader.Authorization)).toContain("tinycloud.capabilities/read");
});

test("the MCP grant's consent: the same consent and grant as production", async () => {
  const session = await consentSession(MCP_CONSENT_MANIFEST).signIn();
  expect(signed.map(consent)).toEqual([production.mcpConsent.consent]);
  expect(recaps(session.siwe)).toEqual(production.mcpConsent.recaps);
});
