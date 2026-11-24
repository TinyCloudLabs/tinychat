// Whether the web SDK shows its own "requesting additional permissions" dialog before OpenKey's sign screen, on the real
// SDK: the real SDK signs in and runs requestPermissions; only the node, the dialog (the SDK's showModal test hook) and
// OpenKey's signMessage are stand-ins. TinyChat declares an OpenKey-managed key's signer, so OpenKey's screen is the only
// ask; any other key keeps the SDK's dialog. Details: TC-4210
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import { createTinyCloudWeb, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "../lib/homeFeatures";
import { WEB_APP_MANIFEST } from "../lib/webSignInPrefetch";
import type { connectWallet } from "@tinyboilerplate/client";
import { authorizeBotHistory, botHistoryOwnerPermissions, clearHistoryDecline, HISTORY_DECLINED } from "../bots/historyAuthorization";
import { earlierHistoryPermissions } from "../bots/earlierHistory";
import { requestEarlierHistoryAccess } from "../bots/earlierHistoryRequest";
import { stepUpForApp, type StepUpConnect } from "./stepUp";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const config = { autoCreateSpace: false, includeAccountRegistryPermissions: false as const, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST };
const realFetch = globalThis.fetch;
let restoreDom: () => void;
/** The asks in the order they reached the owner: "dialog" for the SDK's own, "sign" for OpenKey's. */
let events: string[] = [];

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
  events = [];
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
  Object.assign(tcw, { _testHooks: { showModal: async () => { dialogs.shown++; events.push("dialog"); return { approved: true }; } } });
  return { tcw, dialogs };
}

/** OpenKey, as far as TinyChat can tell: records each sign request and signs it, or rejects it as OpenKey's sign screen does when the owner says no. */
function openkey(answer: "approve" | "decline" = "approve") {
  const requests: { message: string }[] = [];
  const client = {
    signMessage: async (request: { message: string }) => {
      requests.push(request);
      events.push("sign");
      // @openkey/sdk rejects a closed or declined request with this object, not an Error.
      if (answer === "decline") throw { code: "USER_CANCELLED", message: "User cancelled the request" };
      return { signature: await account.signMessage({ message: request.message }) };
    },
  };
  return { requests, client };
}

/** OpenKey's connect for this account; `keyType` is left out when undefined, as a connect that does not report it. */
function connection(ok: ReturnType<typeof openkey>, keyType?: string) {
  const connects = { count: 0 };
  const connect = async () => { connects.count++; return { address: ADDRESS, openkey: ok.client, ...(keyType === undefined ? {} : { keyType }) }; };
  return { connect: connect as StepUpConnect, history: connect as unknown as typeof connectWallet, connects };
}

// Only an OpenKey-managed key has OpenKey's own approval screen. An external-wallet key signs in the wallet, and an
// unknown key type is treated the same, so the SDK's dialog (which states the permissions and their limit) comes first.
const KEY_TYPES = [
  { label: "an OpenKey-managed key", keyType: "MANAGED", order: ["sign"] },
  { label: "an external-wallet key", keyType: "EXTERNAL", order: ["dialog", "sign"] },
  { label: "a key of unknown type", keyType: undefined, order: ["dialog", "sign"] },
] as const;

for (const { label, keyType, order } of KEY_TYPES) {
  const asks = order.length === 1 ? "no SDK dialog and exactly one OpenKey sign request" : "the SDK dialog and then exactly one OpenKey sign request";

  test(`One Apps step-up on the real SDK with ${label}: ${asks}`, async () => {
    const { tcw, dialogs } = await signedIn();
    const ok = openkey();
    expect(await stepUpForApp(tcw, ask, connection(ok, keyType).connect)).toBe(true);
    expect(events).toEqual([...order]);
    expect(dialogs.shown).toBe(order.length - 1);
    expect(ok.requests).toHaveLength(1);
  });

  test(`bot history authorization on the real SDK with ${label}: ${asks}`, async () => {
    const { tcw, dialogs } = await signedIn();
    const ok = openkey();
    // The grant is the part under test; the node holds no key network here, so the step after it is expected to fail.
    await authorizeBotHistory(tcw, connection(ok, keyType).history, async () => ({ enabled: true }), { postDescriptor: async () => {} }).catch(() => {});
    expect(tcw.hasPermissions(ask)).toBe(true);
    expect(events).toEqual([...order]);
    expect(dialogs.shown).toBe(order.length - 1);
    expect(ok.requests).toHaveLength(1);
  });

  test(`moving earlier bot history on the real SDK with ${label}: ${asks}`, async () => {
    const { tcw, dialogs } = await signedIn();
    const ok = openkey();
    expect(await requestEarlierHistoryAccess(tcw, connection(ok, keyType).history)).toBe(true);
    expect(tcw.hasPermissions(earlierHistoryPermissions(ADDRESS, 1))).toBe(true);
    expect(events).toEqual([...order]);
    expect(dialogs.shown).toBe(order.length - 1);
    expect(ok.requests).toHaveLength(1);
  });
}

test("an owner who declines on OpenKey's screen is asked once for bot history: one sign request and the decline both times", async () => {
  clearHistoryDecline();
  try {
    const { tcw, dialogs } = await signedIn();
    const ok = openkey("decline");
    const { history, connects } = connection(ok, "MANAGED");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(authorizeBotHistory(tcw, history, async () => ({ enabled: true }), { postDescriptor: async () => {} })).rejects.toThrow(HISTORY_DECLINED);
    }
    expect(ok.requests).toHaveLength(1);
    expect(connects.count).toBe(1);
    expect(dialogs.shown).toBe(0);
    expect(tcw.hasPermissions(ask)).toBe(false);
  } finally {
    clearHistoryDecline();
  }
});

test("an owner who declines moving earlier bot history on OpenKey's screen gets false, not an error", async () => {
  const { tcw, dialogs } = await signedIn();
  const ok = openkey("decline");
  expect(await requestEarlierHistoryAccess(tcw, connection(ok, "MANAGED").history)).toBe(false);
  expect(ok.requests).toHaveLength(1);
  expect(dialogs.shown).toBe(0);
});

test("an owner who declines the One Apps step-up on OpenKey's screen gets false, not an error", async () => {
  const { tcw, dialogs } = await signedIn();
  const ok = openkey("decline");
  expect(await stepUpForApp(tcw, ask, connection(ok, "MANAGED").connect)).toBe(false);
  expect(ok.requests).toHaveLength(1);
  expect(dialogs.shown).toBe(0);
});

test("a signer not declared OpenKey still gets the SDK dialog first, so the checks above can fail", async () => {
  const { tcw, dialogs } = await signedIn();
  const ok = openkey();
  tcw.setRuntimePermissionSigner({ signMessage: async (message) => (await ok.client.signMessage({ message })).signature });
  expect((await tcw.requestPermissions(ask, { expiryMs: 3_600_000 })).approved).toBe(true);
  expect(dialogs.shown).toBe(1);
  expect(ok.requests).toHaveLength(1);
});
