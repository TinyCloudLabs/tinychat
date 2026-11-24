// Whether the web SDK shows its own "requesting additional permissions" dialog before OpenKey's sign screen, on the real
// SDK: the real SDK signs in and runs requestPermissions; only the node, the dialog (the SDK's showModal test hook) and
// OpenKey's signMessage are stand-ins. TinyChat declares its OpenKey signer, so OpenKey's screen is the only ask. Details: TC-4210
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "../lib/homeFeatures";
import { WEB_APP_MANIFEST } from "../lib/webSignInPrefetch";
import type { connectWallet } from "@tinyboilerplate/client";
import { authorizeBotHistory, botHistoryOwnerPermissions } from "../bots/historyAuthorization";
import { earlierHistoryPermissions } from "../bots/earlierHistory";
import { requestEarlierHistoryAccess } from "../bots/earlierHistoryRequest";
import { stepUpForApp, type StepUpConnect } from "./stepUp";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const config = { autoCreateSpace: false, includeAccountRegistryPermissions: false as const, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST };
const realFetch = globalThis.fetch;
let restoreDom: () => void;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.pathname.includes("/locations/")) return Response.json({ error: "location record not found" }, { status: 404 });
    return new Response(
      url.pathname.endsWith("/info") ? JSON.stringify({ protocol: 1, version: "test", features: ["kv", "delegation", "sql", "hooks", "encryption", "encryption-named-keys-v1"], nodeId: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }) : "{}",
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
      const raw = String(params![0]);
      return account.signMessage({ message: raw.startsWith("0x") ? Buffer.from(raw.slice(2), "hex").toString("utf8") : raw });
    }
    throw new Error(`unsupported ${method}`);
  },
} as EIP1193Provider;

const ask: PermissionEntry[] = botHistoryOwnerPermissions(ADDRESS);

/** A real signed-in SDK client whose own dialog is counted (and approved) instead of rendered. */
async function signedIn() {
  const tcw = createTinyCloudWeb(wallet, { ...config, manifest: webSignInManifest(WEB_APP_MANIFEST, [], ADDRESS) });
  await tcw.signIn();
  const dialogs = { shown: 0 };
  Object.assign(tcw, { _testHooks: { showModal: async () => { dialogs.shown++; return { approved: true }; } } });
  return { tcw, dialogs };
}

/** OpenKey, as far as TinyChat can tell: records each sign request and signs it. */
function openkey() {
  const requests: { message: string }[] = [];
  const client = { signMessage: async (request: { message: string }) => { requests.push(request); return { signature: await account.signMessage({ message: request.message }) }; } };
  return { requests, client };
}

test("One Apps step-up on the real SDK: no SDK dialog and exactly one OpenKey sign request", async () => {
  const { tcw, dialogs } = await signedIn();
  const ok = openkey();
  const connect: StepUpConnect = async () => ({ address: ADDRESS, openkey: ok.client });
  expect(await stepUpForApp(tcw, ask, connect)).toBe(true);
  expect(dialogs.shown).toBe(0);
  expect(ok.requests).toHaveLength(1);
});

test("bot history authorization on the real SDK: no SDK dialog and exactly one OpenKey sign request", async () => {
  const { tcw, dialogs } = await signedIn();
  const ok = openkey();
  const connect = (async () => ({ address: ADDRESS, openkey: ok.client })) as unknown as typeof connectWallet;
  // The grant is the part under test; the node holds no key network here, so the step after it is expected to fail.
  await authorizeBotHistory(tcw, connect, async () => ({ enabled: true }), { postDescriptor: async () => {} }).catch(() => {});
  expect(tcw.hasPermissions(ask)).toBe(true);
  expect(dialogs.shown).toBe(0);
  expect(ok.requests).toHaveLength(1);
});

test("moving earlier bot history on the real SDK: no SDK dialog and exactly one OpenKey sign request", async () => {
  const { tcw, dialogs } = await signedIn();
  const ok = openkey();
  const connect = (async () => ({ address: ADDRESS, openkey: ok.client })) as unknown as typeof connectWallet;
  expect(await requestEarlierHistoryAccess(tcw, connect)).toBe(true);
  expect(tcw.hasPermissions(earlierHistoryPermissions(ADDRESS, 1))).toBe(true);
  expect(dialogs.shown).toBe(0);
  expect(ok.requests).toHaveLength(1);
});

test("a signer not declared OpenKey still gets the SDK dialog first, so the checks above can fail", async () => {
  const { tcw, dialogs } = await signedIn();
  const ok = openkey();
  tcw.setRuntimePermissionSigner({ signMessage: async (message) => (await ok.client.signMessage({ message })).signature });
  expect((await tcw.requestPermissions(ask, { expiryMs: 3_600_000 })).approved).toBe(true);
  expect(dialogs.shown).toBe(1);
  expect(ok.requests).toHaveLength(1);
});
