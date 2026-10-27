// Mounted-App proof of what the session restore hands to restoreTinyCloudWebSession: with the local copy
// ON the replication option AND a read-only account provider (so the SDK's restore has a signer to ask,
// and is not left refused as `gate_unavailable`), with it OFF neither. Run by
// src/App.restoreProvider.test.ts in its own process (mock.module is process-wide).
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "@/lib/platform";

const restoreImportDom = installDom();
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
const replicationClientApi = await import("@/lib/replication/replicationClient");

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const APP_SESSION_KEY = "xyz.tinycloud.tinychat:session";

interface RestoreConfig { provider?: { request(args: { method: string }): Promise<unknown> }; replication?: unknown }
const restoreConfigs: RestoreConfig[] = [];
let replicationOn = true;

function makeTcw(): TinyCloudWeb {
  return { did: `did:pkh:eip155:1:${ADDRESS}`, spaceId: "space-a1", address: () => ADDRESS, sql: {}, kv: {}, secrets: {} } as unknown as TinyCloudWeb;
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: ADDRESS, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  loadAppManifest: async () => ({}),
  createTinyCloudWeb: () => Object.assign(makeTcw(), {
    clearPersistedSession: async () => {},
    prepareSignIn: async () => {},
    signIn: async () => ({ siwe: "message", signature: "signature" }),
  }),
  verifySession: async () => ({ token: "bearer", expiresIn: 3600, address: ADDRESS }),
  // Records what the app's restore call passes; the real SDK is not under test here.
  restoreTinyCloudWebSession: async (_address: string, config: RestoreConfig) => {
    restoreConfigs.push(config);
    return { status: "restored", tcw: makeTcw() };
  },
}));
// The real plugin and storage are not what is under test: only whether the replication option is built.
// replicationRestorePatch (the real one) calls this export.
mock.module("@/lib/replication/replicationClient", () => ({
  ...replicationClientApi,
  replicationConfigPatch: async () => (replicationOn ? { replication: { enabled: true } } : {}),
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

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  await act(async () => { await tick(); await tick(); await tick(); });
}
async function mount(platform: AppPlatform = "web") {
  restoreDom = installDom();
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
/** The app's session and manifest-revision records live in the global localStorage, which survives a re-mount. */
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

/** Signs in (which stores the session), drops the page, and boots again so the stored session restores. */
async function signInThenReload(): Promise<void> {
  await mount();
  await click("Sign in");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  await unmount();
  restoreConfigs.length = 0;
  // (As in App.auth.fixture.tsx: the revision record survives in the global store, the session record is re-seeded.)
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 3_600_000, address: ADDRESS }));
  await mount();
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
}

beforeEach(() => {
  restoreConfigs.length = 0;
  replicationOn = true;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: memoryLocalStorage() });
});
afterEach(async () => { await unmount(); });
afterAll(() => { mock.restore(); restoreImportDom(); Reflect.deleteProperty(globalThis, "localStorage"); });

test("restore with the local copy ON passes the replication option and a provider that answers the stored address", async () => {
  await signInThenReload();
  expect(restoreConfigs).toHaveLength(1);
  const config = restoreConfigs[0]!;
  expect(config.replication).toBeDefined();
  expect(config.provider).toBeDefined();
  expect(await config.provider!.request({ method: "eth_accounts" })).toEqual([ADDRESS]);
  await expect(config.provider!.request({ method: "personal_sign" })).rejects.toMatchObject({ code: 4200 });
  await expect(config.provider!.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({ code: 4200 });
});

test("restore with the local copy OFF passes neither: no replication option, no provider key at all", async () => {
  replicationOn = false;
  await signInThenReload();
  expect(restoreConfigs).toHaveLength(1);
  expect("provider" in restoreConfigs[0]!).toBe(false);
  expect("replication" in restoreConfigs[0]!).toBe(false);
});
