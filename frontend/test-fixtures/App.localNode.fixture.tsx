// Mounted-App proof of the local node address and the node ID check. Run by src/App.localNode.test.ts in
// its own process per NODE_FIXTURE_MODE (the address is read once, when App is imported):
//   local:  the desktop app with a saved address http://127.0.0.1:8765
//   hosted: the desktop app with an invalid saved value (cleared, ignored) and no address
// Everything that would reach a node is recorded; the SDK itself is not under test.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext } from "@/lib/platform";

const mode = process.env.NODE_FIXTURE_MODE === "hosted" ? "hosted" : "local";
const NODE = "http://127.0.0.1:8765";
const ID_A = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN1";
const ID_B = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN2";
const HOST_KEY = "xyz.tinycloud.tinychat:node-host";
const PIN_KEY = `xyz.tinycloud.tinychat:node-pin:${NODE}`;
const APP_SESSION_KEY = "xyz.tinycloud.tinychat:session";
const ADDRESS = "0x00000000000000000000000000000000000000a1";

// A tool home that is not the real one, asserted before anything runs.
if (!process.env.HOME?.startsWith("/var/tmp/tc1769.")) throw new Error("run with HOME under /var/tmp/tc1769.*");

const restoreImportDom = installDom();
Object.assign(window, { __TAURI_INTERNALS__: {} });
const clientApi = await import("@tinyboilerplate/client");
const nativeApi = await import("@/lib/openkeyNative");
const renewalApi = await import("@/lib/openkeyNativeRenewal");
const signOutApi = await import("@/lib/openkeySignOut");
const pipelineApi = await import("@/lib/voiceNotes/voiceNotePipeline");
const grantApi = await import("@/lib/connectors/encryptionGrant");
const captureApi = await import("@/lib/voiceNotes/captureEngine");
const agentEnablementApi = await import("@/chat/useAgentEnablement");
const transcriberSyncApi = await import("@/chat/useTranscriberLibrarySync");
const recorderProviderApi = await import("@/capture/recorder/RecorderProvider");
const uploadResumerApi = await import("@/capture/upload/UploadResumer");

function memoryLocalStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: memoryLocalStorage() });
localStorage.setItem(HOST_KEY, mode === "local" ? NODE : "https://evil.example");

interface SdkConfig { tinycloudHosts?: string[] }
const signInConfigs: SdkConfig[] = [];
const restoreConfigs: SdkConfig[] = [];
let failSignIn: false | "generic" | "node-info" = false;
// "blocked": listening, but a cross-origin read is refused (a node started without CORS); only a no-cors request gets through.
let info: "A" | "B" | "down" | "blocked" = "A";
const fetchCalls: { url: string; method: string }[] = [];
const nodeCalls = () => fetchCalls.filter((call) => call.url.startsWith(NODE)).map((call) => `${call.method} ${call.url.slice(NODE.length)}`);

function fakeTcw(): TinyCloudWeb {
  return { did: `did:pkh:eip155:1:${ADDRESS}`, spaceId: "space-a1", address: () => ADDRESS, hosts: signInConfigs.at(-1)?.tinycloudHosts, sql: {}, kv: {}, secrets: {} } as unknown as TinyCloudWeb;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  fetchCalls.push({ url, method: init?.method ?? "GET" });
  if (url.startsWith(NODE)) {
    if (info === "down") throw new TypeError("connection refused");
    if (info === "blocked") {
      if (init?.mode === "no-cors") return new Response(null, { status: 200 });
      throw new TypeError("Failed to fetch");
    }
    return new Response(JSON.stringify({ protocol: 1, nodeId: info === "A" ? ID_A : ID_B }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: ADDRESS, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  loadAppManifest: async () => ({}),
  createAndSignIn: async (_provider: unknown, config: SdkConfig) => {
    signInConfigs.push(config);
    if (failSignIn === "node-info") throw Object.assign(new Error("Failed to fetch node info at http://127.0.0.1:8765. Ensure the node is running and the /info endpoint is accessible."), { name: "VersionCheckError" });
    if (failSignIn) throw new Error("sign-in failed");
    return { tcw: fakeTcw(), session: { siwe: "message", signature: "signature" } };
  },
  verifySession: async () => ({ token: "bearer", expiresIn: 3600, address: ADDRESS }),
  restoreTinyCloudWebSession: async (_address: string, config: SdkConfig) => {
    restoreConfigs.push(config);
    return { status: "restored", tcw: fakeTcw() };
  },
}));
mock.module("@/lib/openkeyNative", () => ({
  ...nativeApi,
  isNativeOpenKeySignIn: () => false,
  isNativeOpenKeySession: () => false,
  restoreNativeAtBoot: async () => ({ kind: "none" }),
  nativeRenewalServices: async () => ({}),
  secretsAvailable: () => false,
}));
mock.module("@/lib/openkeyNativeRenewal", () => ({
  ...renewalApi,
  NativeRenewal: class { start() {} stop() {} },
  guardNativeTinyCloudCalls: (tcw: TinyCloudWeb) => tcw,
}));
mock.module("@/lib/openkeySignOut", () => ({ ...signOutApi, signOutOpenKeySession: async () => ({ status: "cancelled" }) }));
mock.module("@/lib/connectors/encryptionGrant", () => ({ ...grantApi, withEncryptionDecryptGrant: (manifest: unknown) => manifest }));
mock.module("@/lib/voiceNotes/voiceNotePipeline", () => ({ ...pipelineApi, createVoiceNotePipeline: () => null }));
mock.module("@/lib/voiceNotes/captureEngine", () => ({
  ...captureApi,
  captureCapabilities: () => ({ offlineRecorder: false, micDeniedPresentation: false }),
  captureEngineAvailable: () => false,
}));
mock.module("../src/chat/ChatWorkspace", () => ({
  ChatWorkspace: ({ settings }: { settings: React.ReactNode }) => <div data-testid="authenticated-workspace">{settings}</div>,
}));
mock.module("../src/chat/SettingsPage", () => ({ SettingsPage: () => null }));
mock.module("../src/chat/useAgentEnablement", () => ({
  ...agentEnablementApi,
  AgentAccessProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module("../src/chat/useTranscriberLibrarySync", () => ({
  ...transcriberSyncApi,
  TranscriberLibrarySyncProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module("../src/capture/recorder/RecorderProvider", () => ({
  ...recorderProviderApi,
  RecorderProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module("../src/capture/upload/UploadResumer", () => ({ ...uploadResumerApi, UploadResumer: () => null }));
mock.module("../src/capture/recorder/RecorderShell", () => ({
  RecorderShell: ({ chat, settings }: { chat: React.ReactNode; settings: React.ReactNode }) => <>{chat}{settings}</>,
}));

const { App } = await import("../src/App");
const copy = await import("../src/lib/nodeHostCopy");

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  await act(async () => { await tick(); await tick(); await tick(); await tick(); });
}
async function mount() {
  restoreDom = installDom();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><PlatformContext.Provider value="tauri"><App /></PlatformContext.Provider></BrowserRouter>));
  await settle();
}
async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  restoreDom?.();
  restoreDom = undefined;
}
async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  expect(button, `missing ${label}; DOM=${document.body.innerHTML}`).toBeTruthy();
  await act(async () => { button!.click(); await tick(); });
  await settle();
}
const signedIn = () => document.body.querySelector('[data-testid="authenticated-workspace"]') !== null;
const seedSession = () => localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 3_600_000, address: ADDRESS }));
const savePin = (id: string) => localStorage.setItem(PIN_KEY, JSON.stringify({ nodeId: id, firstSeenAt: "2026-10-24T00:00:00.000Z" }));
const readPin = () => localStorage.getItem(PIN_KEY);
/** Everything sent to the node was a read of /info, and nothing else reached it. */
const onlyInfoReads = () => nodeCalls().every((call) => call === "GET /info");

beforeEach(() => {
  signInConfigs.length = 0;
  restoreConfigs.length = 0;
  fetchCalls.length = 0;
  failSignIn = false;
  info = "A";
  localStorage.removeItem(PIN_KEY);
  localStorage.removeItem(APP_SESSION_KEY);
});
afterEach(async () => { await unmount(); });
afterAll(() => { mock.restore(); restoreImportDom(); Reflect.deleteProperty(globalThis, "localStorage"); });

if (mode === "local") {
  test("first sign-in: /info, then the question, then sign-in on that host, then the saved node ID", async () => {
    await mount();
    await click("Sign in");
    expect(document.body.textContent).toContain(copy.NODE_CONFIRM_TITLE);
    expect(document.body.textContent).toContain(ID_A);
    expect(signInConfigs).toHaveLength(0);
    expect(readPin()).toBeNull();
    await click(copy.NODE_CONFIRM_CONFIRM);
    expect(signInConfigs).toHaveLength(1);
    expect(signInConfigs[0]!.tinycloudHosts).toEqual([NODE]);
    expect(signedIn()).toBe(true);
    expect(JSON.parse(readPin()!)).toMatchObject({ nodeId: ID_A });
    expect(onlyInfoReads()).toBe(true);
  });

  test("cancelling the question signs nothing in and saves nothing", async () => {
    await mount();
    await click("Sign in");
    await click(copy.NODE_CONFIRM_CANCEL);
    expect(signInConfigs).toHaveLength(0);
    expect(readPin()).toBeNull();
    expect(signedIn()).toBe(false);
    expect(onlyInfoReads()).toBe(true);
  });

  test("a first sign-in that fails saves no node ID", async () => {
    failSignIn = true;
    await mount();
    await click("Sign in");
    await click(copy.NODE_CONFIRM_CONFIRM);
    expect(signInConfigs).toHaveLength(1);
    expect(signedIn()).toBe(false);
    expect(readPin()).toBeNull();
  });

  test("the saved node answering: sign-in goes through with no question and the saved ID is untouched", async () => {
    savePin(ID_A);
    await mount();
    await click("Sign in");
    expect(document.body.textContent).not.toContain(copy.NODE_CONFIRM_TITLE);
    expect(signedIn()).toBe(true);
    expect(signInConfigs[0]!.tinycloudHosts).toEqual([NODE]);
    expect(JSON.parse(readPin()!)).toEqual({ nodeId: ID_A, firstSeenAt: "2026-10-24T00:00:00.000Z" });
  });

  test("a different node at the address: sign-in refused, only GET /info reaches it, the saved ID stays", async () => {
    savePin(ID_A);
    info = "B";
    await mount();
    await click("Sign in");
    expect(document.body.textContent).toContain(copy.nodeRefusal(NODE));
    expect(signInConfigs).toHaveLength(0);
    expect(signedIn()).toBe(false);
    expect(nodeCalls().length).toBeGreaterThan(0);
    expect(onlyInfoReads()).toBe(true);
    expect(JSON.parse(readPin()!).nodeId).toBe(ID_A);
  });

  test("a node that cannot be reached: a plain error, no sign-in, no other host tried", async () => {
    savePin(ID_A);
    info = "down";
    await mount();
    await click("Sign in");
    expect(document.body.textContent).toContain(copy.nodeUnreachable(NODE));
    expect(signInConfigs).toHaveLength(0);
    expect(restoreConfigs).toHaveLength(0);
    expect(onlyInfoReads()).toBe(true);
  });

  test("restore with the saved node answering restores on that host", async () => {
    savePin(ID_A);
    seedSession();
    await mount();
    expect(restoreConfigs).toHaveLength(1);
    expect(restoreConfigs[0]!.tinycloudHosts).toEqual([NODE]);
    expect(signedIn()).toBe(true);
  });

  test("restore with a different node at the address: nothing is built or sent but GET /info", async () => {
    savePin(ID_A);
    seedSession();
    info = "B";
    await mount();
    expect(restoreConfigs).toHaveLength(0);
    expect(signInConfigs).toHaveLength(0);
    expect(signedIn()).toBe(false);
    expect(document.body.textContent).toContain(copy.nodeRefusal(NODE));
    expect(nodeCalls().length).toBeGreaterThan(0);
    expect(onlyInfoReads()).toBe(true);
    expect(JSON.parse(readPin()!).nodeId).toBe(ID_A);
  });

  test("restore with the node down: an error, no restore attempt", async () => {
    savePin(ID_A);
    seedSession();
    info = "down";
    await mount();
    expect(restoreConfigs).toHaveLength(0);
    expect(signedIn()).toBe(false);
    expect(document.body.textContent).toContain(copy.nodeUnreachable(NODE));
  });

  test("a stored session with no saved node ID is dropped, not restored", async () => {
    seedSession();
    await mount();
    expect(restoreConfigs).toHaveLength(0);
    expect(signedIn()).toBe(false);
    expect(localStorage.getItem(APP_SESSION_KEY)).toBeNull();
    expect(onlyInfoReads()).toBe(true);
  });

  test("the node changing under a signed-in session is caught when the window returns", async () => {
    savePin(ID_A);
    await mount();
    await click("Sign in");
    expect(signedIn()).toBe(true);
    info = "B";
    fetchCalls.length = 0;
    await act(async () => { window.dispatchEvent(new window.Event("focus")); await tick(); });
    await settle();
    expect(signedIn()).toBe(false);
    expect(document.body.textContent).toContain(copy.nodeRefusal(NODE));
    expect(onlyInfoReads()).toBe(true);
  });

  test("forgetting the saved node ID from the refusal screen clears the stored session and the SDK's session record", async () => {
    const sdkRecord = `tinycloud:session:${ADDRESS}`;
    savePin(ID_A);
    seedSession();
    localStorage.setItem(sdkRecord, "{}");
    info = "B";
    await mount();
    expect(document.body.textContent).toContain(copy.nodeRefusal(NODE));
    expect(localStorage.getItem(sdkRecord)).not.toBeNull();
    await click(copy.NODE_FORGET_BUTTON);
    await click(copy.NODE_FORGET_CONFIRM);
    expect(readPin()).toBeNull();
    expect(localStorage.getItem(APP_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(sdkRecord)).toBeNull();
  });

  test("the signed-out screen offers the saved-ID reset, so a refusal can be undone", async () => {
    savePin(ID_A);
    info = "B";
    await mount();
    await click("Sign in");
    expect(document.body.textContent).toContain(copy.NODE_FORGET_BUTTON);
  });

  test("a node that is listening but cannot be read (started without CORS): the CORS sentence, no sign-in", async () => {
    savePin(ID_A);
    info = "blocked";
    await mount();
    await click("Sign in");
    expect(document.body.textContent).toContain(copy.nodeSignInFailed(NODE));
    expect(document.body.textContent).not.toContain(copy.nodeUnreachable(NODE));
    expect(signInConfigs).toHaveLength(0);
    expect(onlyInfoReads()).toBe(true);
  });

  test("the SDK failing to read the node's /info during sign-in gets the CORS sentence; any other failure keeps the generic message", async () => {
    savePin(ID_A);
    failSignIn = "node-info";
    await mount();
    await click("Sign in");
    expect(signInConfigs).toHaveLength(1);
    expect(document.body.textContent).toContain(copy.nodeSignInFailed(NODE));
    await unmount();
    failSignIn = "generic";
    await mount();
    await click("Sign in");
    expect(document.body.textContent).not.toContain(copy.nodeSignInFailed(NODE));
    expect(document.body.textContent).toContain("Please try again");
  });
}

if (mode === "hosted") {
  test("no node address: nothing asks a node for /info, no saved node ID is written, the SDK gets its own default host", async () => {
    await mount();
    await click("Sign in");
    expect(signedIn()).toBe(true);
    expect(signInConfigs[0]!.tinycloudHosts).toBeUndefined();
    expect(fetchCalls.some((call) => call.url.endsWith("/info"))).toBe(false);
    expect(localStorage.getItem(PIN_KEY)).toBeNull();
    expect(document.body.textContent).not.toContain(copy.NODE_CONFIRM_TITLE);
  });

  test("a saved value that is not a loopback address is removed at startup and ignored", () => {
    expect(localStorage.getItem(HOST_KEY)).toBeNull();
  });

  test("restore with no node address makes no /info request", async () => {
    seedSession();
    await mount();
    expect(restoreConfigs).toHaveLength(1);
    expect(restoreConfigs[0]!.tinycloudHosts).toBeUndefined();
    expect(fetchCalls.some((call) => call.url.endsWith("/info"))).toBe(false);
  });
}
