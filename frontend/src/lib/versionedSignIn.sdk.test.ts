// TinyChat's web sign-in through OpenKey's versioned authorization (`authorizeTinyCloud`), run on the real web SDK.
// OpenKey is a stub that signs the SIWE it is handed, as OpenKey's server does; the wallet provider only names the
// account and chain, so its `personal_sign` must never be called.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BrowserSessionStorage } from "@tinycloud/web-sdk";
import { createAndSignIn, createTinyCloudWeb, NarrowedApprovalError, type EIP1193Provider } from "@tinyboilerplate/client";
import { authErrorMessage, SIGN_IN_FAILED_MESSAGE } from "./authErrors";
import { narrowedApprovalMessage } from "./narrowedApproval";
import { installDom } from "@/test/dom";
import { openKeyStub } from "@/test/openkeyStub";
import { webSignInManifest } from "./homeFeatures";
import { createWebSignInPrefetch, guardOpenKey, WEB_APP_MANIFEST } from "./webSignInPrefetch";

const account = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const ADDRESS = account.address;
const HOST = "http://127.0.0.1:9";
const NONCE = "abcdef0123456789";
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

function setup() {
  const calls = { personalSign: 0, authorize: [] as { siwe: string; mode?: string; host?: string }[] };
  const wallet = {
    on() {}, removeListener() {},
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [ADDRESS];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") { calls.personalSign++; throw new Error("personal_sign must not be used"); }
      throw new Error(`unsupported ${method}`);
    },
  } as EIP1193Provider;
  const client = openKeyStub(account, "approve", (request, options) => { calls.authorize.push({ siwe: request.siwe, mode: options?.mode, host: request.host }); });
  return { calls, wallet, client };
}

test("sign-in goes through OpenKey's versioned authorization, in the frame, with the backend's nonce in the signed SIWE", async () => {
  const { calls, wallet, client } = setup();
  const { session } = await createAndSignIn(wallet, { ...config, manifest, address: ADDRESS, nonce: NONCE, openkey: { client, mode: "iframe" } });
  expect(calls.personalSign).toBe(0);
  expect(calls.authorize).toHaveLength(1);
  expect(calls.authorize[0]!.mode).toBe("iframe");
  expect(calls.authorize[0]!.siwe).toContain(`Nonce: ${NONCE}`);
  // What /auth/verify receives: a SIWE with that nonce and the owner's signature over exactly it.
  expect(session.siwe).toBe(calls.authorize[0]!.siwe);
  expect(session.address.toLowerCase()).toBe(ADDRESS.toLowerCase());
  expect(await verifyMessage({ address: ADDRESS, message: session.siwe, signature: session.signature as `0x${string}` })).toBe(true);
});

test("without the OpenKey config the wallet's personal_sign still signs, as before", async () => {
  const { calls, wallet } = setup();
  const signing = { ...wallet, request: async (args: { method: string; params?: unknown[] }) => {
    if (args.method === "personal_sign") {
      calls.personalSign++;
      const message = String(args.params![0]);
      return account.signMessage({ message: message.startsWith("0x") ? { raw: message as `0x${string}` } : message });
    }
    return wallet.request(args);
  } } as EIP1193Provider;
  const session = await createTinyCloudWeb(signing, { ...config, manifest }).signIn();
  expect(calls.personalSign).toBe(1);
  expect(calls.authorize).toHaveLength(0);
  expect(session.address.toLowerCase()).toBe(ADDRESS.toLowerCase());
});

test("the nonce rule holds on this path: a nonce that ages out while the owner is on OpenKey's screen is reported as expired", async () => {
  const { calls, wallet, client } = setup();
  let now = 0;
  const prefetch = createWebSignInPrefetch("http://backend.invalid", { now: () => now, requestNonce: async () => NONCE });
  const nonce = await prefetch.nonceForSigning(ADDRESS);
  const slow = {
    authorizeTinyCloud: async (request: { siwe: string }, options?: { mode?: string }) => {
      now = 4 * 60_000; // the owner takes four minutes on the review screen
      return client.authorizeTinyCloud(request, options);
    },
  };
  await expect(createAndSignIn(prefetch.guardSigning(wallet), {
    ...config, manifest, address: ADDRESS, nonce, openkey: { client: guardOpenKey(prefetch, slow), mode: "iframe" },
  })).rejects.toThrow(/nonce expired/i);
  expect(calls.authorize).toHaveLength(1);
});

test("a sign-in cancelled before OpenKey opens never opens it", async () => {
  const { calls, wallet, client } = setup();
  const prefetch = createWebSignInPrefetch("http://backend.invalid", { requestNonce: async () => NONCE });
  const nonce = await prefetch.nonceForSigning(ADDRESS);
  prefetch.cancel();
  await expect(createAndSignIn(prefetch.guardSigning(wallet), {
    ...config, manifest, address: ADDRESS, nonce, openkey: { client: guardOpenKey(prefetch, client), mode: "iframe" },
  })).rejects.toThrow(/cancelled/i);
  expect(calls.authorize).toHaveLength(0);
});

test("an approval narrowed in OpenKey's review is refused with what is missing, and leaves no session", async () => {
  const calls = { authorize: 0 };
  const { wallet } = setup();
  // The owner unticks everything that touches SQL (the library and the feed).
  const narrowing = openKeyStub(account, "approve", () => { calls.authorize++; }, (_resource, ability) => !ability.startsWith("tinycloud.sql/"));
  let caught: unknown;
  try {
    await createAndSignIn(wallet, { ...config, manifest, address: ADDRESS, nonce: NONCE, openkey: { client: narrowing, mode: "iframe" } });
  } catch (error) { caught = error; }
  expect(calls.authorize).toBe(1);
  expect(caught).toBeInstanceOf(NarrowedApprovalError);
  const missing = (caught as NarrowedApprovalError).missing;
  expect(missing.length).toBeGreaterThan(0);
  expect(missing.every((entry) => entry.service === "tinycloud.sql")).toBe(true);
  // What the owner reads: which permissions, never the generic failure.
  const message = authErrorMessage(caught);
  expect(message).toBe(narrowedApprovalMessage(missing));
  expect(message).toContain("keep your library, feed and recordings");
  expect(message).not.toBe(SIGN_IN_FAILED_MESSAGE);
  // Nothing was kept: no persisted session for the owner.
  expect(await new BrowserSessionStorage().load(ADDRESS)).toBeNull();
});

test("a whole approval is kept: nothing is refused when every permission is ticked", async () => {
  const { wallet } = setup();
  const whole = openKeyStub(account, "approve", undefined, () => true);
  const { session } = await createAndSignIn(wallet, { ...config, manifest, address: ADDRESS, nonce: NONCE, openkey: { client: whole, mode: "iframe" } });
  expect(session.address.toLowerCase()).toBe(ADDRESS.toLowerCase());
});
