// Mounted-App proof of the web's least-privilege sign-in: no connector secrets or decrypt grant until Connectors is
// used, asked for in place when it is opened, and nothing else (Recording, chat, the feed) ever asks. Run by
// src/App.connectorsGrant.test.ts in its own process (mock.module is process-wide).
import { newIdbEnv } from "@/lib/voiceNotes/web/testing/idb";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { validateManifest } from "@tinycloud/sdk-core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext } from "@/lib/platform";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const APP_SESSION_KEY = "xyz.tinycloud.tinychat:session";
const REVISION_KEY = `xyz.tinycloud.tinychat:manifest-revision:${ADDRESS}`;
const FEATURES_KEY = `xyz.tinycloud.tinychat:home-features:${ADDRESS}`;
const NOTICE = "Sign in once more so TinyCloud One can open your apps and your feed. Your data stays as it is.";
const readManifest = (name: string) => validateManifest(JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8")));

const restoreImportDom = installDom();
const clientApi = await import("@tinyboilerplate/client");
const nativeApi = await import("@/lib/openkeyNative");
const renewalApi = await import("@/lib/openkeyNativeRenewal");
const restoreApi = await import("@/lib/sessionRestore");
const signOutApi = await import("@/lib/openkeySignOut");
const pipelineApi = await import("@/lib/voiceNotes/voiceNotePipeline");
const grantApi = await import("@/lib/connectors/encryptionGrant");
const delegationApi = await import("@/lib/transcriptDelegation");
const captureApi = await import("@/lib/voiceNotes/captureEngine");
const audioCacheApi = await import("@/lib/voiceNotes/audioReceiptUpgrade");
// Taken before the mocks are installed: a module namespace is live, so reading it later returns the mock.
const realUseAudioCacheBoot = audioCacheApi.useAudioCacheBoot;
const agentEnablementApi = await import("@/chat/useAgentEnablement");
const drainApi = await import("@/chat/useBackgroundDrain");
const transcriberSyncApi = await import("@/chat/useTranscriberLibrarySync");
const recorderProviderApi = await import("@/capture/recorder/RecorderProvider");
const appShellApi = await import("@/shell/AppShell");
const laneApi = await import("@/lib/spaceWriteLane");
const feedApi = await import("@/feed/FeedView");
const webSdkApi = await import("@tinycloud/web-sdk");

let lastRestoreConfig: { manifest?: unknown } | null = null;
let restoreThroughSdk = false;
let lastSignInConfig: { manifest: unknown; includeAccountRegistryPermissions?: unknown } | null = null;
let decryptGrantCalls = 0;
let delegationCalls = 0;
const audioCacheBootArgs: Array<TinyCloudWeb | null> = [];
let transcriberSyncEnabled: boolean | null = null;
const mounted: string[] = [];
// What the signed-in session's own approval covers (the Home base, or the base plus the flagged sets).
let signInCovers = false;
// How the owner answers the in-place re-authorise, and when (null: at once).
let reauthAnswer: "approve" | "decline" = "approve";
let reauthSignInGate: Promise<void> | null = null;
let reauthConfig: { manifest: unknown } | null = null;
let reauthInstances = 0;
// Held open to stand for a slow backend check of the re-authorised sign-in (null: at once).
let verifyGate: Promise<void> | null = null;
let verifyCalls = 0;
// What the re-authorise saved where the live session is persisted (BrowserSessionStorage), in order, and what was
// saved there before it. `snapshotGate`/`saveGate` hold the read of the saved session or the save (null: at once).
const persistedSessions: unknown[] = [];
const OLD_SESSION = { tag: "old session" };
let snapshotGate: { reached(): void; release: Promise<void> } | null = null;
let saveGate: { reached(): void; release: Promise<void> } | null = null;
let engineAvailable = false;
let restoreResult: unknown = { kind: "signedOut" };
const recorderEnabled: Array<boolean | undefined> = [];
const feedTcws: Array<TinyCloudWeb | null> = [];
const fetchedUrls: string[] = [];

function fakeTcw(covers: boolean, tag: string): TinyCloudWeb {
  return {
    tag, did: `did:pkh:eip155:1:${ADDRESS}`, spaceId: "space-a1", address: () => ADDRESS, sql: {}, secrets: {},
    hasPermissions: () => covers,
    kv: { get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "none" } }) },
    cleanup: () => {},
  } as unknown as TinyCloudWeb;
}
function spy(name: string) {
  return function Spy() { mounted.push(name); return null; };
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: ADDRESS, openkey: {}, web3Provider: { request: async () => null } }),
  requestNonce: async () => "nonce",
  createAndSignIn: async (_provider: unknown, config: typeof lastSignInConfig) => {
    lastSignInConfig = config;
    return { tcw: fakeTcw(signInCovers, "signed-in"), session: { siwe: "message", signature: "signature" } };
  },
  restoreTinyCloudWebSession: async (_address: string, config: { manifest?: unknown }) => {
    lastRestoreConfig = config;
    return { status: "restored", tcw: fakeTcw(signInCovers, "restored") };
  },
  // The in-place re-authorise's separate instance.
  createTinyCloudWeb: (_provider: unknown, config: { manifest: unknown; sessionStorage: { save(address: string, data: unknown): Promise<void> } }) => {
    reauthConfig = config;
    reauthInstances += 1;
    return {
      ...fakeTcw(true, "re-authorised"),
      signIn: async () => {
        if (reauthSignInGate) await reauthSignInGate;
        if (reauthAnswer === "decline") throw { code: "USER_CANCELLED" };
        await config.sessionStorage.save(ADDRESS, { tag: "re-authorised session" });
        return { siwe: "message-2", signature: "signature-2" };
      },
    };
  },
  verifySession: async (_url: string, siwe: string) => {
    if (siwe === "message-2") {
      verifyCalls += 1;
      if (verifyGate) await verifyGate;
    }
    return { token: "bearer", expiresIn: 3600, address: ADDRESS };
  },
}));
mock.module("@tinycloud/web-sdk", () => ({
  ...webSdkApi,
  BrowserSessionStorage: class {
    async save(_address: string, data: unknown) {
      if (saveGate && data !== OLD_SESSION) { saveGate.reached(); await saveGate.release; }
      persistedSessions.push(data);
    }
    async load() {
      if (snapshotGate) { snapshotGate.reached(); await snapshotGate.release; }
      return persistedSessions.at(-1) ?? OLD_SESSION;
    }
    async clear() { persistedSessions.push(null); }
    exists() { return true; }
    isAvailable() { return true; }
  },
}));
mock.module("@/lib/openkeyNative", () => ({
  ...nativeApi,
  isNativeOpenKeySignIn: () => false,
  isNativeOpenKeySession: () => false,
  restoreNativeAtBoot: async () => ({ kind: "none" }),
  nativeRenewalServices: async () => ({}),
  // A vault is available, so only the build decides whether the background lanes mount.
  secretsAvailable: () => true,
}));
mock.module("@/lib/openkeyNativeRenewal", () => ({
  ...renewalApi,
  NativeRenewal: class { start() {} stop() {} },
  guardNativeTinyCloudCalls: (tcw: TinyCloudWeb) => tcw,
}));
mock.module("@/lib/sessionRestore", () => ({
  ...restoreApi,
  browserIsOffline: () => false,
  restorePersistedSession: async (_store: unknown, deps: { loadManifest(): Promise<unknown>; restore(address: string, manifest: unknown): Promise<{ tcw: unknown }> }) => {
    if (!restoreThroughSdk) return restoreResult;
    const result = await deps.restore(ADDRESS, await deps.loadManifest());
    return { kind: "restored", address: ADDRESS, tcw: result.tcw };
  },
}));
mock.module("@/lib/openkeySignOut", () => ({ ...signOutApi, signOutOpenKeySession: async () => ({ status: "cancelled" }) }));
mock.module("@/lib/connectors/encryptionGrant", () => ({
  ...grantApi,
  withEncryptionDecryptGrant: (manifest: object) => { decryptGrantCalls += 1; return { ...manifest, decryptGrant: true }; },
}));
mock.module("@/lib/transcriptDelegation", () => ({
  ...delegationApi,
  ensureTranscriptWriterDelegation: async () => { delegationCalls += 1; return "disabled"; },
}));
mock.module("@/lib/voiceNotes/voiceNotePipeline", () => ({ ...pipelineApi, createVoiceNotePipeline: () => null }));
// No recorder unless a test gives one.
mock.module("@/lib/voiceNotes/captureEngine", () => ({
  ...captureApi,
  captureCapabilities: () => ({ offlineRecorder: false, micDeniedPresentation: false }),
  captureEngineAvailable: () => engineAvailable,
}));
mock.module("@/lib/voiceNotes/audioReceiptUpgrade", () => ({
  ...audioCacheApi,
  useAudioCacheBoot: (tcw: TinyCloudWeb | null) => { audioCacheBootArgs.push(tcw); realUseAudioCacheBoot(tcw); },
}));
mock.module("../src/chat/ChatWorkspace", () => ({
  ChatWorkspace: ({ settings }: { settings: React.ReactNode }) => <div data-testid="authenticated-workspace">{settings}</div>,
}));
mock.module("../src/chat/SettingsPage", () => ({
  SettingsPage: ({ onSignOut }: { onSignOut: () => void }) => <div data-testid="settings-page"><button type="button" onClick={() => onSignOut()}>Sign out</button></div>,
}));
mock.module("../src/chat/useAgentEnablement", () => ({
  ...agentEnablementApi,
  AgentAccessProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module("../src/chat/useBackgroundDrain", () => ({ ...drainApi, BackgroundDrainer: spy("BackgroundDrainer") }));
mock.module("../src/chat/useGmeetSessionSync", () => ({ GmeetSessionSync: spy("GmeetSessionSync") }));
mock.module("../src/chat/BackendReconciler", () => ({ BackendReconciler: spy("BackendReconciler") }));
mock.module("../src/capture/upload/UploadResumer", () => ({ UploadResumer: spy("UploadResumer") }));
mock.module("../src/chat/ConnectorsPage", () => ({ ConnectorsPage: spy("ConnectorsPage") }));
mock.module("../src/capture/CaptureSurface", () => ({ CaptureSurface: spy("CaptureSurface") }));
mock.module("../src/chat/MeetingsSection", () => ({ MeetingsSection: spy("MeetingsSection") }));
mock.module("../src/feed/FeedView", () => ({
  ...feedApi,
  FeedView: ({ tcw }: { tcw: TinyCloudWeb | null }) => { feedTcws.push(tcw); return <div data-testid="feed-view" />; },
}));
mock.module("../src/chat/useTranscriberLibrarySync", () => ({
  ...transcriberSyncApi,
  TranscriberLibrarySyncProvider: ({ enabled, children }: { enabled?: boolean; children: React.ReactNode }) => {
    transcriberSyncEnabled = enabled ?? true;
    return <>{children}</>;
  },
}));
mock.module("../src/capture/recorder/RecorderProvider", () => ({
  ...recorderProviderApi,
  RecorderProvider: ({ enabled, children }: { enabled?: boolean; children: React.ReactNode }) => {
    recorderEnabled.push(enabled);
    return <recorderProviderApi.StaticRecorderProvider value={{ available: false }}>{children}</recorderProviderApi.StaticRecorderProvider>;
  },
}));
// The real frame, so the navigation and the in-place prompts are the real ones.
mock.module("../src/capture/recorder/RecorderShell", () => ({
  RecorderShell: ({ onOpenNote: _onOpenNote, ...shell }: Record<string, unknown>) => <appShellApi.AppShell {...(shell as never)} />,
}));

const { App } = await import("../src/App");

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  await act(async () => { await tick(); await tick(); await tick(); });
}
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
async function mount(path = "/chat") {
  restoreDom = installDom({ localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage });
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><PlatformContext.Provider value="web"><App /></PlatformContext.Provider></BrowserRouter>));
  await settle();
  const deadline = Date.now() + 1000;
  while (host!.textContent?.includes("Restoring your session") && Date.now() < deadline) await settle();
}
async function signIn() {
  const button = [...host!.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Sign in");
  expect(button, `missing Sign in; DOM=${host!.innerHTML}`).toBeTruthy();
  await act(async () => { button!.click(); await tick(); });
  const deadline = Date.now() + 1000;
  while (!host!.querySelector("[data-testid=feed-view], [data-testid=authenticated-workspace]") && Date.now() < deadline) await settle();
}
async function navigate(path: string) {
  await act(async () => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new window.Event("popstate"));
    await tick();
  });
  await settle();
}
const navLabels = () => [...host!.querySelectorAll("nav a")].map((link) => link.textContent?.trim());

const realFetch = globalThis.fetch;
beforeEach(() => {
  lastRestoreConfig = null;
  restoreThroughSdk = false;
  lastSignInConfig = null;
  decryptGrantCalls = 0;
  delegationCalls = 0;
  audioCacheBootArgs.length = 0;
  transcriberSyncEnabled = null;
  mounted.length = 0;
  signInCovers = false;
  reauthAnswer = "approve";
  reauthSignInGate = null;
  reauthConfig = null;
  reauthInstances = 0;
  verifyGate = null;
  verifyCalls = 0;
  persistedSessions.length = 0;
  snapshotGate = null;
  saveGate = null;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: newIdbEnv().factory });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: newIdbEnv().keyRange });
  engineAvailable = false;
  restoreResult = { kind: "signedOut" };
  recorderEnabled.length = 0;
  feedTcws.length = 0;
  fetchedUrls.length = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: memoryLocalStorage() });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchedUrls.push(String(input));
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  restoreDom?.();
  restoreDom = undefined;
  __resetStorageStatusForTests();
});
afterAll(() => { mock.restore(); restoreImportDom(); globalThis.fetch = realFetch; Reflect.deleteProperty(globalThis, "localStorage"); });

test("a fresh web sign-in asks for manifest.json with no connector secrets and no decrypt grant", async () => {
  await mount();
  await signIn();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  const config = lastSignInConfig!;
  expect(config.includeAccountRegistryPermissions).toBe(false);
  expect(config.manifest).toEqual({ ...readManifest("manifest.json"), secrets: {} });
  expect(JSON.stringify(config.manifest)).not.toContain("tinycloud.encryption");
  expect(decryptGrantCalls).toBe(0);
  // Recording's transcript delegation runs at sign-in, as before.
  expect(delegationCalls).toBeGreaterThan(0);
});

test("a Recording flag left by the old Home site asks for nothing more at sign-in", async () => {
  localStorage.setItem(FEATURES_KEY, JSON.stringify(["recording"]));
  await mount();
  await signIn();
  expect(lastSignInConfig!.manifest).toEqual({ ...readManifest("manifest.json"), secrets: {} });
  expect(decryptGrantCalls).toBe(0);
});

const CONNECTORS_LANES = ["BackgroundDrainer", "GmeetSessionSync", "BackendReconciler"];
const RECORDING_LANES = ["UploadResumer"];
const meetingsRequests = () => fetchedUrls.filter((url) => url.includes("/api/connectors/meetings"));
const prompt = (feature: string) => host!.querySelector(`[data-testid="feature-access-${feature}"]`);
const tagOf = (tcw: TinyCloudWeb | null | undefined) => (tcw as { tag?: string } | null | undefined)?.tag;
async function clickInPrompt(feature: string, label: string) {
  const button = [...prompt(feature)!.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
  await act(async () => { button.click(); await tick(); });
  await settle();
}

test("before Connectors is used, Recording's lanes run and no connector lane starts or asks the meetings route", async () => {
  await mount();
  await signIn();
  for (const lane of RECORDING_LANES) expect(mounted).toContain(lane);
  for (const lane of CONNECTORS_LANES) expect(mounted).not.toContain(lane);
  expect(transcriberSyncEnabled).toBe(true);
  expect(audioCacheBootArgs.some((tcw) => tcw !== null)).toBe(true);
  expect(meetingsRequests()).toEqual([]);
});

test("Recording needs no re-authorise: it opens on the sign-in session with no prompt", async () => {
  engineAvailable = true;
  await mount();
  await signIn();
  for (const path of ["/chat/capture", "/chat/capture/library"]) {
    await navigate(path);
    expect(prompt("recording")).toBeNull();
    expect(prompt("connectors")).toBeNull();
    expect(mounted).toContain("CaptureSurface");
  }
  expect(recorderEnabled.at(-1)).toBe(true);
  expect(reauthConfig).toBeNull();
  expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
});

test("navigation, and Connectors asking in place", async () => {
  await mount("/chat");
  await signIn();
  expect(navLabels()).toEqual(["One Feed", "Chat", "Apps", "Recording", "Connectors"]);
  await navigate("/chat/connectors");
  expect(prompt("connectors")?.querySelector("h2")?.textContent).toBe("Allow Connectors");
  expect(host!.querySelectorAll("main").length).toBe(1);
  expect(mounted).not.toContain("ConnectorsPage");
  expect(reauthConfig).toBeNull();
});

test("web sign-in remembers Connectors in the shared device/account feature record", async () => {
  localStorage.setItem(FEATURES_KEY, JSON.stringify(["connectors"]));
  signInCovers = true;
  await mount("/chat/connectors");
  await signIn();
  await navigate("/chat/connectors");
  expect(lastSignInConfig!.manifest).toEqual({ ...readManifest("manifest.json"), decryptGrant: true });
  expect(decryptGrantCalls).toBe(1);
  expect(prompt("connectors")).toBeNull();
  expect(mounted).toContain("ConnectorsPage");
  for (const lane of CONNECTORS_LANES) expect(mounted).toContain(lane);
});

test("opening Connectors asks once: Continue signs the full manifest with decrypt, swaps the session, and it then works", async () => {
  await mount("/chat/connectors");
  await signIn();
  await navigate("/chat/connectors");
  expect(prompt("connectors")?.textContent).toContain("Allow Connectors");
  expect(mounted).not.toContain("ConnectorsPage");
  await clickInPrompt("connectors", "Continue");
  expect(reauthInstances).toBe(1);
  expect(reauthConfig!.manifest).toEqual({ ...readManifest("manifest.json"), decryptGrant: true });
  expect(persistedSessions).toEqual([{ tag: "re-authorised session" }]);
  expect(window.location.pathname).toBe("/chat/connectors");
  expect(prompt("connectors")).toBeNull();
  expect(mounted).toContain("ConnectorsPage");
  expect(JSON.parse(localStorage.getItem(FEATURES_KEY)!)).toEqual(["connectors"]);
  for (const lane of CONNECTORS_LANES) expect(mounted).toContain(lane);
  await navigate("/chat/feed");
  expect(tagOf(feedTcws.at(-1))).toBe("re-authorised");
  // Back to Connectors: no second ask.
  await navigate("/chat/connectors");
  expect(prompt("connectors")).toBeNull();
  expect(reauthInstances).toBe(1);
});

test("declining Connectors access leaves the session and feed working, sets no flag, and leaves a plain retry", async () => {
  reauthAnswer = "decline";
  await mount("/chat/connectors");
  await signIn();
  await navigate("/chat/connectors");
  await clickInPrompt("connectors", "Continue");
  expect(prompt("connectors")?.textContent).toContain("Permission wasn't given. Nothing changed.");
  expect([...prompt("connectors")!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Continue", "Not now"]);
  expect(persistedSessions).toEqual([]);
  expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
  expect(mounted).not.toContain("ConnectorsPage");
  for (const lane of CONNECTORS_LANES) expect(mounted).not.toContain(lane);
  await navigate("/chat/feed");
  expect(host!.querySelector('[data-testid="feed-view"]')).toBeTruthy();
  expect(tagOf(feedTcws.at(-1))).toBe("signed-in");
});

test("Continue waits while an upload or a save is writing, and comes back when it ends", async () => {
  await mount();
  await signIn();
  await navigate("/chat/connectors");
  const write = Promise.withResolvers<void>();
  let running!: Promise<void>;
  await act(async () => { running = laneApi.runOnSpaceLane(() => write.promise); await tick(); });
  const continueButton = () => [...prompt("connectors")!.querySelectorAll("button")].find((entry) => entry.textContent === "Continue")!;
  expect(continueButton().disabled).toBe(true);
  expect(prompt("connectors")?.textContent).toContain("Finish the current recording or upload first.");
  await act(async () => { write.resolve(); await running; });
  await settle();
  expect(continueButton().disabled).toBe(false);
  expect(prompt("connectors")?.textContent).not.toContain("Finish the current recording or upload first.");
});

const signedOutNow = () => [...host!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in");
async function signOutFromSettings() {
  await navigate("/chat/settings");
  const button = [...host!.querySelectorAll("button")].find((entry) => entry.textContent === "Sign out")!;
  await act(async () => { button.click(); await tick(); });
  const deadline = Date.now() + 1000;
  while (!signedOutNow() && Date.now() < deadline) await settle();
}

test("an approval that lands after the owner signed out keeps nothing: no saved session, no swap, still signed out", async () => {
  const verification = Promise.withResolvers<void>();
  verifyGate = verification.promise;
  await mount();
  await signIn();
  await navigate("/chat/connectors");
  await clickInPrompt("connectors", "Continue");
  expect(verifyCalls).toBe(1);
  await signOutFromSettings();
  expect(signedOutNow()).toBe(true);
  await act(async () => { verification.resolve(); await tick(); });
  await settle();
  expect(persistedSessions).toEqual([]);
  expect(localStorage.getItem(APP_SESSION_KEY)).toBeNull();
  expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
  expect(signedOutNow()).toBe(true);
  expect(mounted).not.toContain("ConnectorsPage");
});

test("work that starts while OpenKey is open stops the swap: nothing saved, the session and feed stay, and the prompt says why", async () => {
  const approval = Promise.withResolvers<void>();
  reauthSignInGate = approval.promise;
  await mount();
  await signIn();
  await navigate("/chat/connectors");
  await clickInPrompt("connectors", "Continue");
  const write = Promise.withResolvers<void>();
  let running!: Promise<void>;
  await act(async () => { running = laneApi.runOnSpaceLane(() => write.promise); await tick(); });
  await act(async () => { approval.resolve(); await tick(); });
  await settle();
  expect(persistedSessions).toEqual([]);
  expect(mounted).not.toContain("ConnectorsPage");
  expect(prompt("connectors")?.querySelector('[role="alert"]')?.textContent).toBe("Finish the current recording or upload first.");
  await act(async () => { write.resolve(); await running; });
  await navigate("/chat/feed");
  expect(tagOf(feedTcws.at(-1))).toBe("signed-in");
});

/** A gate a fake storage call waits at: `reached` resolves when the call gets there, `open` lets it through. */
function gate() {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { held: { reached: () => reached.resolve(), release: release.promise }, reached: reached.promise, open: () => release.resolve() };
}
/** Press a prompt button without waiting for what it starts. */
async function pressInPrompt(feature: string, label: string) {
  const button = [...prompt(feature)!.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
  await act(async () => { button.click(); await tick(); });
}

test("work that starts while the saved session is being read stops the swap before anything is written; Feed stays", async () => {
  const snapshot = gate();
  snapshotGate = snapshot.held;
  await mount();
  await signIn();
  await navigate("/chat/connectors");
  await pressInPrompt("connectors", "Continue");
  await snapshot.reached;
  const write = Promise.withResolvers<void>();
  let running!: Promise<void>;
  await act(async () => { running = laneApi.runOnSpaceLane(() => write.promise); await tick(); });
  await act(async () => { snapshot.open(); await tick(); });
  await settle();
  expect(persistedSessions).toEqual([]);
  expect(mounted).not.toContain("ConnectorsPage");
  expect(prompt("connectors")?.querySelector('[role="alert"]')?.textContent).toBe("Finish the current recording or upload first.");
  await act(async () => { write.resolve(); await running; });
  await navigate("/chat/feed");
  expect(tagOf(feedTcws.at(-1))).toBe("signed-in");
});

test("work that starts while the new session is being saved stops the swap at the app: the saved session is put back", async () => {
  const save = gate();
  saveGate = save.held;
  await mount();
  await signIn();
  await navigate("/chat/connectors");
  await pressInPrompt("connectors", "Continue");
  await save.reached;
  const write = Promise.withResolvers<void>();
  let running!: Promise<void>;
  await act(async () => { running = laneApi.runOnSpaceLane(() => write.promise); await tick(); });
  await act(async () => { save.open(); await tick(); });
  await settle();
  // Saved, then put back: what is persisted is the session from before the ask.
  expect(persistedSessions).toEqual([{ tag: "re-authorised session" }, OLD_SESSION]);
  expect(mounted).not.toContain("ConnectorsPage");
  expect(prompt("connectors")?.querySelector('[role="alert"]')?.textContent).toBe("Finish the current recording or upload first.");
  expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
  await act(async () => { write.resolve(); await running; });
  await navigate("/chat/feed");
  expect(tagOf(feedTcws.at(-1))).toBe("signed-in");
});

test("a second ask while OpenKey is open joins the first: one sign-in, not two", async () => {
  const approval = Promise.withResolvers<void>();
  reauthSignInGate = approval.promise;
  await mount();
  await signIn();
  await navigate("/chat/connectors");
  await clickInPrompt("connectors", "Continue");
  // Leaving and coming back shows a fresh prompt whose Continue is usable again.
  await navigate("/chat/feed");
  await navigate("/chat/connectors");
  await clickInPrompt("connectors", "Continue");
  expect(reauthInstances).toBe(1);
  await act(async () => { approval.resolve(); await tick(); });
  await settle();
  expect(reauthInstances).toBe(1);
  expect(persistedSessions).toHaveLength(1);
});

test("a session saved under the current revision restores with no re-sign notice", async () => {
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 3_600_000, address: ADDRESS }));
  localStorage.setItem(REVISION_KEY, "4");
  await mount();
  expect(host!.textContent).not.toContain(NOTICE);
  expect(localStorage.getItem(REVISION_KEY)).toBe("4");
});

test("web restore checks the reduced base so a non-Connectors session can reload", async () => {
  restoreThroughSdk = true;
  localStorage.setItem(REVISION_KEY, "4");
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 60_000, address: ADDRESS }));
  await mount();
  expect(lastRestoreConfig!.manifest).toEqual({ ...readManifest("manifest.json"), secrets: {} });
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});

test("an old full web session remembers a connected source and keeps its background lanes", async () => {
  const restored = fakeTcw(true, "restored");
  const queries: string[] = [];
  restored.sql = { db: () => ({ query: async (sql: string) => {
    queries.push(sql);
    return { ok: true, data: { rows: [["fireflies", "connected", null, null, null, 0]] } };
  } }) } as unknown as TinyCloudWeb["sql"];
  localStorage.setItem(REVISION_KEY, "4");
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 60_000, address: ADDRESS }));
  restoreResult = { kind: "restored", tcw: restored, address: ADDRESS };
  await mount();
  expect(JSON.parse(localStorage.getItem(FEATURES_KEY)!)).toEqual(["connectors"]);
  const connectionReads = queries.filter((sql) => sql.includes("FROM connector_state"));
  expect(connectionReads).toHaveLength(1);
  expect(connectionReads[0]).toStartWith("SELECT connector_id");
  for (const lane of CONNECTORS_LANES) expect(mounted).toContain(lane);
});

test("an old full web session without a connected source leaves the feature record unset", async () => {
  const restored = fakeTcw(true, "restored");
  restored.sql = { db: () => ({ query: async () => ({ ok: true, data: { rows: [] } }) }) } as unknown as TinyCloudWeb["sql"];
  localStorage.setItem(REVISION_KEY, "4");
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 60_000, address: ADDRESS }));
  restoreResult = { kind: "restored", tcw: restored, address: ADDRESS };
  await mount();
  expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
});

test("the desktop app keeps its sign-in: the full manifest with decrypt, and Connectors opens with no ask", async () => {
  await mount("/chat/connectors");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  try {
    signInCovers = true;
    await signIn();
    expect(lastSignInConfig!.manifest).toEqual({ ...readManifest("manifest.json"), decryptGrant: true });
    expect(decryptGrantCalls).toBe(1);
    await navigate("/chat/connectors");
    expect(prompt("connectors")).toBeNull();
    expect(mounted).toContain("ConnectorsPage");
    expect(reauthConfig).toBeNull();
  } finally {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
});
