// Mounted-App proof, desktop (Tauri) offline recorder: a session saved under an older sign-in manifest is
// cleared by the revision gate, and the signed-out recorder screen shows the re-sign notice with a Sign in
// action (not "Couldn't sign in"), keeps the recorder in place, and the user can sign in from it. Run by
// src/App.resignForward.test.ts in its own process (mock.module is process-wide).
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { replicationOptInKey } from "@/lib/replication/replicationOptIn";
import { REPLICATION_RUNTIME_FLAG_KEY } from "@/lib/replication/replicationFlag";

// The app code under test must never reach a real home: HOME is a throwaway dir under /var/tmp,
// set at load and asserted before anything runs.
const testHome = mkdtempSync("/var/tmp/tc2056.");
process.env.HOME = testHome;
if (!process.env.HOME.startsWith("/var/tmp/tc2056.")) throw new Error("HOME is not the throwaway test home");
afterAll(() => { rmSync(testHome, { recursive: true, force: true }); });

const restoreImportDom = installDom();
const clientApi = await import("@tinyboilerplate/client");
// Taken before the mock is installed: a module namespace is live, so reading it later returns the mock.
const realClearPersistedSession = clientApi.clearPersistedSession;
const nativeApi = await import("@/lib/openkeyNative");
const renewalApi = await import("@/lib/openkeyNativeRenewal");
const restoreApi = await import("@/lib/sessionRestore");
const signOutApi = await import("@/lib/openkeySignOut");
const pipelineApi = await import("@/lib/voiceNotes/voiceNotePipeline");
const handoffApi = await import("@/lib/voiceNotes/accountHandoff");
const nativeVoiceNotesApi = await import("@/lib/voiceNotes/nativeVoiceNotes");
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
const NOTICE = "Sign in once more so TinyCloud Home can open your apps and your feed. Your data stays as it is.";

/** Every effect the gate must order, in the order it happened. */
const events: string[] = [];
let handoffResult: { ok: boolean; failClosed: boolean; message: string | null } = { ok: true, failClosed: false, message: null };
let offline = false;

function fakeTcw(): TinyCloudWeb {
  return {
    did: PRINCIPAL, spaceId: "space-a1", address: () => ADDRESS, sql: {}, kv: {}, secrets: {},
    replication: { sync: () => { events.push("sync"); return Promise.resolve(); } },
  } as unknown as TinyCloudWeb;
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: ADDRESS, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  createAndSignIn: async () => { events.push("signIn"); return { tcw: fakeTcw(), session: { siwe: "message", signature: "signature" } }; },
  verifySession: async () => ({ token: "bearer", expiresIn: 3600, address: ADDRESS }),
  clearPersistedSession: (address: string) => { events.push(`clearPersisted:${address}`); realClearPersistedSession(address); },
  restoreTinyCloudWebSession: async () => { events.push("restore"); return { status: "restored", tcw: fakeTcw() }; },
}));
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
// The real restorePersistedSession runs (so a restore that reached the manifest or the SDK is visible
// in `events`); only the connectivity probe is controlled.
mock.module("@/lib/sessionRestore", () => ({ ...restoreApi, browserIsOffline: () => offline }));
mock.module("@/lib/openkeySignOut", () => ({ ...signOutApi, signOutOpenKeySession: async () => ({ status: "cancelled" }) }));
mock.module("@/lib/connectors/encryptionGrant", () => ({ ...grantApi, withEncryptionDecryptGrant: (manifest: unknown) => manifest }));
mock.module("@/lib/voiceNotes/voiceNotePipeline", () => ({ ...pipelineApi, createVoiceNotePipeline: () => null }));
// The capture engine is "available" so the app's real capture handoff runs; the handoff itself is the
// recorded seam (the native plugin is not under test).
mock.module("@/lib/voiceNotes/captureEngine", () => ({
  ...captureApi,
  captureCapabilities: () => ({ offlineRecorder: true, micDeniedPresentation: false }),
  captureEngineAvailable: () => true,
}));
// The recorder screen reads the on-device queue and the local notes: a fake plugin and an idle STT status stand in for the native ones.
// These stay dynamic imports like the captures above: mock.module must be installed after the real namespaces are taken and before App loads.
const fakeVoiceNotesApi = await import("@/lib/voiceNotes/fakeVoiceNotes");
const sttApi = await import("@/lib/voiceNotes/onDeviceStt");
const sttStoreApi = await import("@/lib/voiceNotes/onDeviceSttStore");
sttApi.__setOnDeviceSttForTests({
  status: async () => ({ models: [], pack: "full", autoDownload: false, download: { policy: "system", state: "idle" }, engine: "apple-speech", appleSpeech: "ready", queue: [] }),
  addListener: async () => ({ remove: async () => {} }),
} as unknown as Parameters<typeof sttApi.__setOnDeviceSttForTests>[0]);
sttStoreApi.__resetOnDeviceSttStoreForTests();
mock.module("@/lib/voiceNotes/nativeVoiceNotes", () => ({
  ...nativeVoiceNotesApi,
  VoiceNotes: { ...fakeVoiceNotesApi.createFakeVoiceNotes().plugin, getCaptureDefaults: async () => ({ status: "signed_in", accountDid: PRINCIPAL, transitionGen: 0 }) },
}));
mock.module("@/lib/voiceNotes/accountHandoff", () => ({
  ...handoffApi,
  handoffBeforeCredentialClear: async () => { events.push("handoff"); return handoffResult; },
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
mock.module("../src/capture/recorder/RecordingOverlay", () => ({ RecordingOverlay: () => null }));
// The desktop recorder shell: the real signed-out capture surface, inside a static recorder context.
mock.module("../src/capture/recorder/RecorderShell", () => ({
  RecorderShell: ({ capture }: { capture: React.ReactNode }) =>
    <recorderProviderApi.StaticRecorderProvider value={{ signedIn: false, available: true }}>{capture}</recorderProviderApi.StaticRecorderProvider>,
}));

const { App } = await import("../src/App");

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  await act(async () => { await tick(); await tick(); await tick(); });
}

/** A Chromium web page with the build flag (dev runtime flag) ON and the user's switch ON. */
function qualifyBrowser() {
  const win = window as unknown as { localStorage: Storage };
  win.localStorage.setItem(REPLICATION_RUNTIME_FLAG_KEY, "true");
  win.localStorage.setItem(replicationOptInKey(PRINCIPAL), "true");
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
/** A session saved by a build from before the gate: a stored app session, no revision record. */
function seedSession() {
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 3_600_000, address: ADDRESS }));
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  events.length = 0;
  offline = false;
  handoffResult = { ok: true, failClosed: false, message: null };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: memoryLocalStorage() });
  // The page's backend calls fail like an unreachable network: a refused (401) call would end the session mid-test.
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
});
afterEach(async () => { await unmount(); });
afterAll(() => { mock.restore(); restoreImportDom(); globalThis.fetch = realFetch; Reflect.deleteProperty(globalThis, "localStorage"); });

test("desktop: a forced re-sign shows the re-sign notice on the offline recorder screen, keeps it, and signs in from it", async () => {
  seedSession();
  await mount("tauri");
  expect(events).toEqual(["handoff", `clearPersisted:${ADDRESS}`]);
  expect(localStorage.getItem(APP_SESSION_KEY)).toBeNull();
  const surface = host!.querySelector('[data-testid="capture-surface"]');
  expect(surface, `recorder screen missing; DOM=${host!.innerHTML}`).toBeTruthy();
  expect(surface!.textContent).toContain(NOTICE);
  // The recorder is still offered while signed out.
  expect([...surface!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Record")).toBe(true);
  await click("Sign in");
  await settle();
  expect(events).toEqual(["handoff", `clearPersisted:${ADDRESS}`, "signIn", "sync"]);
  expect(localStorage.getItem(APP_SESSION_KEY)).not.toBeNull();
  await unmount();
  events.length = 0;
  await mount("tauri");
  expect(events).toEqual(["restore", "sync"]);
  expect(host!.textContent).not.toContain(NOTICE);
});

test("desktop: a signed-out user with nothing to re-sign sees no re-sign notice", async () => {
  await mount("tauri");
  const surface = host!.querySelector('[data-testid="capture-surface"]');
  expect(surface).toBeTruthy();
  expect(surface!.textContent).not.toContain(NOTICE);
});
