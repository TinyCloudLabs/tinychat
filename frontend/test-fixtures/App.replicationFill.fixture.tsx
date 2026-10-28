// Mounted-App proof that the first replication sync is started after sign-in and after session
// restore, only when the user's opt-in is ON, and never over a removal that is in flight.
// Run by src/App.replicationFill.test.ts in its own process (mock.module is process-wide).
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { replicationOptInKey } from "@/lib/replication/replicationOptIn";
import { REPLICATION_RUNTIME_FLAG_KEY } from "@/lib/replication/replicationFlag";
import { trackStartupPurge } from "@/lib/replication/replicationStartupPurge";

const restoreImportDom = installDom();
const clientApi = await import("@tinyboilerplate/client");
const nativeApi = await import("@/lib/openkeyNative");
const renewalApi = await import("@/lib/openkeyNativeRenewal");
const restoreApi = await import("@/lib/sessionRestore");
const signOutApi = await import("@/lib/openkeySignOut");
const pipelineApi = await import("@/lib/voiceNotes/voiceNotePipeline");
const grantApi = await import("@/lib/connectors/encryptionGrant");
const captureApi = await import("@/lib/voiceNotes/captureEngine");
const agentEnablementApi = await import("@/chat/useAgentEnablement");
const transcriberSyncApi = await import("@/chat/useTranscriberLibrarySync");
const recorderProviderApi = await import("@/capture/recorder/RecorderProvider");
const uploadResumerApi = await import("@/capture/upload/UploadResumer");
const replicationClientApi = await import("@/lib/replication/replicationClient");

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const PRINCIPAL = `did:pkh:eip155:1:${ADDRESS}`;
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const APP_SESSION_KEY = "xyz.tinycloud.tinychat:session";

let syncCalls = 0;
let syncBehaviour: () => Promise<void> = async () => undefined;
let restoreAs: "signedOut" | "restored" = "signedOut";
let optedIn = true;

function fakeTcw(): TinyCloudWeb {
  return {
    did: PRINCIPAL, spaceId: "space-a1", address: () => ADDRESS, sql: {}, kv: {}, secrets: {},
    replication: { sync: () => { syncCalls += 1; return syncBehaviour(); } },
  } as unknown as TinyCloudWeb;
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: ADDRESS, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  loadAppManifest: async () => ({}),
  createAndSignIn: async () => ({ tcw: fakeTcw(), session: { siwe: "message", signature: "signature" } }),
  verifySession: async () => ({ token: "bearer", expiresIn: 3600, address: ADDRESS }),
}));
// The real plugin and storage are not what is under test: the config patch is empty, while the real
// startReplicationFill (re-exported from the module) decides whether the first sync starts.
const realStartReplicationFill = replicationClientApi.startReplicationFill; // captured before the mock replaces the export
mock.module("@/lib/replication/replicationClient", () => ({
  ...replicationClientApi,
  replicationConfigPatch: async () => ({}),
  startReplicationFill: (tcw: TinyCloudWeb, isEnabled?: () => boolean) =>
    realStartReplicationFill(tcw, isEnabled, { firstLoadSettled: async () => {}, prefixes: ["p/"] }),
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
mock.module("@/lib/sessionRestore", () => ({
  ...restoreApi,
  browserIsOffline: () => false,
  restorePersistedSession: async () => (restoreAs === "restored"
    ? { kind: "restored", tcw: fakeTcw(), address: ADDRESS }
    : { kind: "signedOut" }),
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

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  await act(async () => { await tick(); await tick(); await tick(); });
}

/** A Chromium web page with the build flag (dev runtime flag) ON and the user's switch as configured. */
function qualifyBrowser() {
  const win = window as unknown as { localStorage: Storage };
  win.localStorage.setItem(REPLICATION_RUNTIME_FLAG_KEY, "true");
  win.localStorage.setItem(replicationOptInKey(PRINCIPAL), optedIn ? "true" : "false");
  Object.defineProperties(navigator, {
    userAgent: { configurable: true, value: CHROME },
    userAgentData: { configurable: true, value: { brands: [{ brand: "Chromium" }] } },
    maxTouchPoints: { configurable: true, value: 0 },
    locks: { configurable: true, value: { request: () => undefined } },
  });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: {} });
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: class {} });
}

async function mount(platform: AppPlatform = "web") {
  restoreDom = installDom();
  qualifyBrowser();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><PlatformContext.Provider value={platform}><App /></PlatformContext.Provider></BrowserRouter>));
  await settle();
}
async function click(label: string) {
  const button = [...host!.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  expect(button, `missing ${label}; DOM=${host!.innerHTML}`).toBeTruthy();
  await act(async () => { button!.click(); await tick(); });
}
async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  restoreDom?.();
  restoreDom = undefined;
}
/** The app's own session and manifest-revision records live in the global localStorage, which survives a re-mount. */
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

/** Sign in, drop the page, then boot again with the stored session restoring. */
async function signInThenRestore(): Promise<{ afterSignIn: number; afterRestore: number }> {
  await mount();
  await click("Sign in");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  const afterSignIn = syncCalls;
  await unmount();
  syncCalls = 0;
  restoreAs = "restored";
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 3_600_000, address: ADDRESS }));
  await mount();
  await settle();
  return { afterSignIn, afterRestore: syncCalls };
}

beforeEach(() => {
  syncCalls = 0;
  syncBehaviour = async () => undefined;
  restoreAs = "signedOut";
  optedIn = true;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: memoryLocalStorage() });
});
afterEach(async () => { await unmount(); });
afterAll(() => { mock.restore(); restoreImportDom(); Reflect.deleteProperty(globalThis, "localStorage"); });

test("opt-in ON: the first sync starts once after sign-in and once after a session restore", async () => {
  const { afterSignIn, afterRestore } = await signInThenRestore();
  expect(afterSignIn).toBe(1);
  expect(afterRestore).toBe(1);
});

test("opt-in OFF (build flag on, platform qualified): the first sync never starts, on sign-in or restore", async () => {
  optedIn = false;
  const { afterSignIn, afterRestore } = await signInThenRestore();
  expect(afterSignIn).toBe(0);
  expect(afterRestore).toBe(0);
});

test("a sync that rejects (a gated restore) does not break sign-in", async () => {
  syncBehaviour = async () => { throw Object.assign(new Error("gated"), { code: "REPLICA_GATED" }); };
  await mount();
  await click("Sign in");
  await settle();
  expect(syncCalls).toBe(1);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});

test("a removal of the copy that is still running holds the first sync back until it finishes", async () => {
  const removal = Promise.withResolvers<void>();
  void trackStartupPurge(removal.promise);
  await mount();
  await click("Sign in");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(syncCalls).toBe(0);
  removal.resolve();
  await settle();
  expect(syncCalls).toBe(1);
});
