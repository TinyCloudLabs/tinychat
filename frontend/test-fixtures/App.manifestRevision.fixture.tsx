// Mounted-App proof of the manifest-revision gate at restore: a session saved under an older sign-in
// manifest is handed off, cleared, and met with the sign-in screen carrying the one-line notice, with no
// manifest fetch or storage restore before the handoff; a failed handoff keeps the session; offline defers;
// a new user records the revision with no extra prompt; and the replication first-sync still runs after the
// forced sign-in and after a later restore. Run by src/App.manifestRevision.test.ts in its own process
// (mock.module is process-wide).
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { pkhDid } from "@tinycloud/sdk-core";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { replicationOptInKey } from "@/lib/replication/replicationOptIn";
import { REPLICATION_RUNTIME_FLAG_KEY } from "@/lib/replication/replicationFlag";
import { SIGN_IN_BUNDLE_ENTRIES, TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";
import realManifest from "../public/.well-known/openkey-manifest.json";

// The app code under test must never reach a real home: HOME is a throwaway dir under /var/tmp,
// set at load and asserted before anything runs.
const testHome = mkdtempSync("/var/tmp/tc1013.");
process.env.HOME = testHome;
if (!process.env.HOME.startsWith("/var/tmp/tc1013.")) throw new Error("HOME is not the throwaway test home");
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
const connectorResource = `urn:tinycloud:encryption:${pkhDid(ADDRESS, 1)}:default/${TINYCHAT_KEY_PREFIX}`;
const connectorSiwe = `Resources:\n- urn:recap:${Buffer.from(JSON.stringify({ att: { [connectorResource]: { "tinycloud.encryption/decrypt": [{}] } } })).toString("base64url")}`;
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const APP_SESSION_KEY = "xyz.tinycloud.tinychat:session";
const REVISION_KEY = `xyz.tinycloud.tinychat:manifest-revision:${ADDRESS}`;
const NOTICE = "Sign in once more so TinyCloud Home can open your apps and your feed. Your data stays as it is.";

/** Every effect the gate must order, in the order it happened. */
const events: string[] = [];
let syncCalls = 0;
let handoffResult: { ok: boolean; failClosed: boolean; message: string | null } = { ok: true, failClosed: false, message: null };
let offline = false;
/** What the backend serves at /api/manifest: this build's manifest.json, the same without the bundle (an older backend), or nothing. */
let served: "full" | "old" | "unreachable" = "full";
const oldManifest = {
  ...realManifest,
  keys: [],
  permissions: realManifest.permissions.filter((entry) => !SIGN_IN_BUNDLE_ENTRIES.some((required) => required.service === entry.service && required.path === entry.path)),
};

function makeTcw(): TinyCloudWeb {
  return {
    did: PRINCIPAL, spaceId: "space-a1", address: () => ADDRESS, sql: {}, kv: {}, secrets: {},
    session: () => ({ address: ADDRESS, walletAddress: ADDRESS, chainId: 1, siwe: served === "full" ? connectorSiwe : "" }),
    replication: { sync: () => { events.push("sync"); syncCalls += 1; return Promise.resolve(); } },
  } as unknown as TinyCloudWeb;
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: ADDRESS, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  loadAppManifest: async () => {
    events.push("loadManifest");
    if (served === "unreachable") throw new TypeError("Failed to fetch");
    return served === "old" ? oldManifest : realManifest;
  },
  createTinyCloudWeb: () => Object.assign(makeTcw(), {
    clearPersistedSession: async () => {},
    prepareSignIn: async () => {},
    signIn: async () => { events.push("signIn"); return { siwe: "message", signature: "signature" }; },
  }),
  verifySession: async () => ({ token: "bearer", expiresIn: 3600, address: ADDRESS }),
  clearPersistedSession: (address: string) => { events.push(`clearPersisted:${address}`); realClearPersistedSession(address); },
  restoreTinyCloudWebSession: async () => { events.push("restore"); return { status: "restored", tcw: makeTcw() }; },
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
  captureCapabilities: () => ({ offlineRecorder: false, micDeniedPresentation: false }),
  captureEngineAvailable: () => true,
}));
mock.module("@/lib/voiceNotes/nativeVoiceNotes", () => ({
  ...nativeVoiceNotesApi,
  VoiceNotes: { ...nativeVoiceNotesApi.VoiceNotes, getCaptureDefaults: async () => ({ status: "signed_in", accountDid: PRINCIPAL, transitionGen: 0 }) },
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
  syncCalls = 0;
  offline = false;
  served = "full";
  handoffResult = { ok: true, failClosed: false, message: null };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: memoryLocalStorage() });
  // The page's backend calls fail like an unreachable network: a refused (401) call would end the session mid-test.
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
});
afterEach(async () => { await unmount(); });
afterAll(() => { mock.restore(); restoreImportDom(); globalThis.fetch = realFetch; Reflect.deleteProperty(globalThis, "localStorage"); });

test("a session with no revision record: the served manifest is read, then handoff, clear, then the sign-in screen with the notice; nothing restores", async () => {
  seedSession();
  await mount();
  expect(events).toEqual(["loadManifest", "handoff", `clearPersisted:${ADDRESS}`]);
  expect(localStorage.getItem(APP_SESSION_KEY)).toBeNull();
  expect(host!.textContent).toContain(NOTICE);
  expect([...host!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in")).toBe(true);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();
});

test("a session recorded under the withdrawn revision \"1\" is forced the same way", async () => {
  seedSession();
  localStorage.setItem(REVISION_KEY, "1");
  await mount();
  expect(events).toEqual(["loadManifest", "handoff", `clearPersisted:${ADDRESS}`]);
  expect(host!.textContent).toContain(NOTICE);
});

test("a failed handoff keeps the session: it is not cleared, nothing restores, and the notice is not shown", async () => {
  handoffResult = { ok: false, failClosed: false, message: "Couldn't update this phone's recording settings. Try again." };
  seedSession();
  await mount();
  expect(events).toEqual(["loadManifest", "handoff"]);
  expect(localStorage.getItem(APP_SESSION_KEY)).not.toBeNull();
  expect(host!.textContent).not.toContain(NOTICE);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();
});

test("offline defers: no manifest read, no handoff, no clear, the session record stays, and the notice is not shown", async () => {
  offline = true;
  seedSession();
  await mount();
  expect(events).not.toContain("handoff");
  expect(events.filter((event) => event.startsWith("clearPersisted"))).toEqual([]);
  expect(localStorage.getItem(APP_SESSION_KEY)).not.toBeNull();
  expect(host!.textContent).not.toContain(NOTICE);
});

test("a deferred session is forced on the first online load", async () => {
  offline = true;
  seedSession();
  await mount();
  expect(events).not.toContain("handoff");
  await unmount();
  events.length = 0;
  offline = false;
  await mount();
  expect(events).toEqual(["loadManifest", "handoff", `clearPersisted:${ADDRESS}`]);
  expect(host!.textContent).toContain(NOTICE);
});

test("a backend still serving the older manifest: the stale session is kept, not cleared, no notice, and the page restores it as before", async () => {
  served = "old";
  seedSession();
  await mount();
  expect(events[0]).toBe("loadManifest");
  expect(events).not.toContain("handoff");
  expect(events.filter((event) => event.startsWith("clearPersisted"))).toEqual([]);
  expect(events).toContain("restore");
  expect(host!.textContent).not.toContain(NOTICE);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});

test("an unreachable manifest defers the same way: nothing cleared, no notice", async () => {
  served = "unreachable";
  seedSession();
  await mount();
  expect(events[0]).toBe("loadManifest");
  expect(events).not.toContain("handoff");
  expect(events.filter((event) => event.startsWith("clearPersisted"))).toEqual([]);
  expect(host!.textContent).not.toContain(NOTICE);
});

test("once the backend serves the bundle, the deferred session is forced on the next open", async () => {
  served = "old";
  seedSession();
  await mount();
  expect(events).not.toContain("handoff");
  await unmount();
  events.length = 0;
  served = "full";
  seedSession();
  await mount();
  expect(events).toEqual(["loadManifest", "handoff", `clearPersisted:${ADDRESS}`]);
  expect(host!.textContent).toContain(NOTICE);
});

test("a signed-out new user sees no notice, signs in under the new manifest with no handoff, and the revision \"3\" is recorded", async () => {
  await mount();
  // A signed-out boot may run the capture handoff; it must not clear, fetch the manifest, or restore anything.
  expect(events.filter((event) => event !== "handoff")).toEqual([]);
  events.length = 0;
  expect(host!.textContent).not.toContain(NOTICE);
  await click("Sign in");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(events).not.toContain("handoff");
  expect(localStorage.getItem(REVISION_KEY)).toBe("3");
  await unmount();
  events.length = 0;
  seedSession();
  await mount();
  expect(events).toContain("restore");
  expect(events).not.toContain("handoff");
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});

test("a new user who signs in under a manifest without the bundle is not marked current", async () => {
  served = "old";
  await mount();
  await click("Sign in");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(events).toContain("signIn");
  expect(localStorage.getItem(REVISION_KEY)).toBeNull();
});

test("after a forced re-sign the first replication sync runs after the new sign-in and again after a later restore", async () => {
  seedSession();
  await mount();
  expect(events).toEqual(["loadManifest", "handoff", `clearPersisted:${ADDRESS}`]);
  await click("Sign in");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(host!.textContent).not.toContain(NOTICE);
  // Sign-in, then the sync; the stale session was never restored.
  expect(events).toEqual(["loadManifest", "handoff", `clearPersisted:${ADDRESS}`, "loadManifest", "signIn", "sync"]);
  expect(localStorage.getItem(REVISION_KEY)).toBe("3");

  await unmount();
  events.length = 0;
  syncCalls = 0;
  seedSession();
  await mount();
  expect(events).toEqual(["loadManifest", "restore", "sync"]);
  expect(syncCalls).toBe(1);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});
