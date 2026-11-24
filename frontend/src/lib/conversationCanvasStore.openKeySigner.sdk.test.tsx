// Conversation Canvas access on the real SDK: a session without the canvas grant shows no SDK dialog before OpenKey's sign
// screen. The real SDK signs in and runs requestPermissions; only the node, the dialog (the SDK's showModal test hook) and
// OpenKey's signMessage are stand-ins. Details: TC-4210
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createTinyCloudWeb, type EIP1193Provider } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { webSignInManifest } from "./homeFeatures";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";
import { setNativeSessionActive } from "./openkeyNative";
import type { StepUpConnect } from "../apps/stepUp";
import { CANVAS_ACCESS_MESSAGE, CANVAS_PERMISSIONS, ensureCanvasAccess } from "./conversationCanvasStore";

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


/** A real signed-in SDK client whose own dialog is counted instead of rendered; `withCanvas` is a session signed in after the canvas manifest entry shipped. */
async function signedIn(withCanvas: boolean) {
  const base = withCanvas ? WEB_APP_MANIFEST : { ...WEB_APP_MANIFEST, permissions: WEB_APP_MANIFEST.permissions!.filter((entry) => entry.path !== "canvas") };
  const tcw = createTinyCloudWeb(wallet, { ...config, manifest: webSignInManifest(base, [], ADDRESS) });
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


/** OpenKey as the connect seam: counts connects. */
function connector(ok: ReturnType<typeof openkey>) {
  const connects = { count: 0 };
  const connect: StepUpConnect = async () => { connects.count++; return { address: ADDRESS, openkey: ok.client }; };
  return { connect, connects };
}

test("a session without the canvas grant: no SDK dialog and exactly one OpenKey sign request", async () => {
  const { tcw, dialogs } = await signedIn(false);
  expect(tcw.hasPermissions(CANVAS_PERMISSIONS)).toBe(false);
  const ok = openkey();
  const { connect } = connector(ok);
  await ensureCanvasAccess(tcw, connect);
  expect(tcw.hasPermissions(CANVAS_PERMISSIONS)).toBe(true);
  expect(dialogs.shown).toBe(0);
  expect(ok.requests).toHaveLength(1);
});

test("a session already holding the canvas grant: no OpenKey connect, no sign request, no dialog", async () => {
  const { tcw, dialogs } = await signedIn(true);
  expect(tcw.hasPermissions(CANVAS_PERMISSIONS)).toBe(true);
  const ok = openkey();
  const { connect, connects } = connector(ok);
  await ensureCanvasAccess(tcw, connect);
  expect(connects.count).toBe(0);
  expect(ok.requests).toHaveLength(0);
  expect(dialogs.shown).toBe(0);
});

test("an owner who declines on OpenKey's screen still gets the Canvas access message", async () => {
  const { tcw, dialogs } = await signedIn(false);
  const declined = { requests: [] as { message: string }[], client: { signMessage: async () => { throw new Error("rejected"); } } };
  const { connect } = connector(declined as unknown as ReturnType<typeof openkey>);
  await expect(ensureCanvasAccess(tcw, connect)).rejects.toThrow(CANVAS_ACCESS_MESSAGE);
  expect(tcw.hasPermissions(CANVAS_PERMISSIONS)).toBe(false);
  expect(dialogs.shown).toBe(0);
});

test("the phone app's native OpenKey session keeps the SDK request and never connects OpenKey", async () => {
  const { tcw, dialogs } = await signedIn(false);
  const ok = openkey();
  const { connect, connects } = connector(ok);
  setNativeSessionActive(true);
  try {
    await ensureCanvasAccess(tcw, connect);
  } finally {
    setNativeSessionActive(false);
  }
  expect(connects.count).toBe(0);
  expect(dialogs.shown).toBe(1);
});
