// Mounted-App proof of the Home site's least-privilege sign-in. Run by src/App.homeGrant.test.ts in its own
// process, once with VITE_HOME_SITE=true and once without; the assertions say what each build must do.
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

const HOME = process.env.VITE_HOME_SITE === "true";
const ADDRESS = "0x00000000000000000000000000000000000000a1";
const APP_SESSION_KEY = "xyz.tinycloud.tinychat:session";
const REVISION_KEY = `xyz.tinycloud.tinychat:manifest-revision:${ADDRESS}`;
const FEATURES_KEY = `xyz.tinycloud.tinychat:home-features:${ADDRESS}`;
const NOTICE = "Sign in once more so TinyCloud Home can open your apps and your feed. Your data stays as it is.";
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
const realInstallCaptureEngine = captureApi.installCaptureEngine;
const realUseAudioCacheBoot = audioCacheApi.useAudioCacheBoot;
const agentEnablementApi = await import("@/chat/useAgentEnablement");
const drainApi = await import("@/chat/useBackgroundDrain");
const transcriberSyncApi = await import("@/chat/useTranscriberLibrarySync");
const recorderProviderApi = await import("@/capture/recorder/RecorderProvider");
const appShellApi = await import("@/shell/AppShell");
const { homeSignInManifest } = await import("@/lib/homeFeatures");
const laneApi = await import("@/lib/spaceWriteLane");
const feedApi = await import("@/feed/FeedView");

let lastSignInConfig: { manifest: unknown; includeAccountRegistryPermissions?: unknown } | null = null;
let decryptGrantCalls = 0;
let delegationCalls = 0;
let installEngineCalls = 0;
const audioCacheBootArgs: Array<TinyCloudWeb | null> = [];
let transcriberSyncEnabled: boolean | null = null;
const mounted: string[] = [];
// What the signed-in session's own approval covers (the Home base, or the base plus the flagged sets).
let signInCovers = false;
// How the owner answers the in-place re-authorise.
let reauthAnswer: "approve" | "decline" = "approve";
let reauthConfig: { manifest: unknown } | null = null;
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
  // The in-place re-authorise's separate instance.
  createTinyCloudWeb: (_provider: unknown, config: { manifest: unknown }) => {
    reauthConfig = config;
    return {
      ...fakeTcw(true, "re-authorised"),
      signIn: async () => {
        if (reauthAnswer === "decline") throw { code: "USER_CANCELLED" };
        return { siwe: "message-2", signature: "signature-2" };
      },
    };
  },
  verifySession: async () => ({ token: "bearer", expiresIn: 3600, address: ADDRESS }),
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
  restorePersistedSession: async () => ({ kind: "signedOut" }),
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
// No recorder: the Home site registers no capture engine.
mock.module("@/lib/voiceNotes/captureEngine", () => ({
  ...captureApi,
  captureCapabilities: () => ({ offlineRecorder: false, micDeniedPresentation: false }),
  captureEngineAvailable: () => false,
  installCaptureEngine: (...args: Parameters<typeof realInstallCaptureEngine>) => { installEngineCalls += 1; return realInstallCaptureEngine(...args); },
}));
mock.module("@/lib/voiceNotes/audioReceiptUpgrade", () => ({
  ...audioCacheApi,
  useAudioCacheBoot: (tcw: TinyCloudWeb | null) => { audioCacheBootArgs.push(tcw); realUseAudioCacheBoot(tcw); },
}));
mock.module("../src/chat/ChatWorkspace", () => ({
  ChatWorkspace: ({ settings }: { settings: React.ReactNode }) => <div data-testid="authenticated-workspace">{settings}</div>,
}));
mock.module("../src/chat/SettingsPage", () => ({ SettingsPage: () => <div data-testid="settings-page" /> }));
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
  RecorderProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  restoreDom = installDom();
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><PlatformContext.Provider value="web"><App /></PlatformContext.Provider></BrowserRouter>));
  await settle();
}
async function signIn() {
  const button = [...host!.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Sign in");
  expect(button, `missing Sign in; DOM=${host!.innerHTML}`).toBeTruthy();
  await act(async () => { button!.click(); await tick(); });
  await settle();
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
  lastSignInConfig = null;
  decryptGrantCalls = 0;
  delegationCalls = 0;
  installEngineCalls = 0;
  audioCacheBootArgs.length = 0;
  transcriberSyncEnabled = null;
  mounted.length = 0;
  signInCovers = false;
  reauthAnswer = "approve";
  reauthConfig = null;
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

test("sign-in asks for the manifest this build ships, with the decrypt grant only on the plain build", async () => {
  await mount();
  await signIn();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  const config = lastSignInConfig!;
  expect(config.includeAccountRegistryPermissions).toBe(false);
  if (HOME) {
    // No replica: it would sync transcripts, which the Home grant does not cover.
    expect("replication" in config).toBe(false);
    expect(config.manifest).toEqual(readManifest("manifest.home.json"));
    expect(decryptGrantCalls).toBe(0);
    expect(JSON.stringify(config.manifest)).not.toContain("decryptGrant");
    expect(delegationCalls).toBe(0);
  } else {
    expect(config.manifest).toEqual({ ...readManifest("manifest.json"), decryptGrant: true });
    expect(decryptGrantCalls).toBe(1);
    expect(delegationCalls).toBeGreaterThan(0);
  }
});

test("a feature this device has used is asked for in the same sign-in on the Home site", async () => {
  localStorage.setItem(FEATURES_KEY, JSON.stringify(["recording"]));
  await mount();
  await signIn();
  const config = lastSignInConfig!;
  if (HOME) {
    expect(config.manifest).toEqual(homeSignInManifest(readManifest("manifest.home.json"), ["recording"], ADDRESS));
    expect(localStorage.getItem(REVISION_KEY)).toBe("home-1");
  } else {
    expect(config.manifest).toEqual({ ...readManifest("manifest.json"), decryptGrant: true });
  }
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

test("without the feature flag the Home site starts no recording, connector or transcript lane, and asks the meetings route nothing", async () => {
  await mount();
  await signIn();
  const lanes = [...CONNECTORS_LANES, ...RECORDING_LANES];
  if (HOME) {
    expect(mounted.filter((name) => lanes.includes(name))).toEqual([]);
    expect(transcriberSyncEnabled).toBe(false);
  } else {
    for (const lane of lanes) expect(mounted).toContain(lane);
    expect(transcriberSyncEnabled).toBe(true);
  }
  expect(meetingsRequests()).toEqual([]);
});

test("with the flag set and a session covering the flagged sets, the Home site starts their lanes", async () => {
  if (!HOME) return;
  localStorage.setItem(FEATURES_KEY, JSON.stringify(["recording", "connectors"]));
  signInCovers = true;
  await mount();
  await signIn();
  for (const lane of [...CONNECTORS_LANES, ...RECORDING_LANES]) expect(mounted).toContain(lane);
  expect(transcriberSyncEnabled).toBe(true);
  expect(audioCacheBootArgs.some((tcw) => tcw !== null)).toBe(true);
});

test("a flag the session does not cover starts nothing on the Home site", async () => {
  if (!HOME) return;
  localStorage.setItem(FEATURES_KEY, JSON.stringify(["recording", "connectors"]));
  signInCovers = false;
  await mount();
  await signIn();
  expect(mounted.filter((name) => [...CONNECTORS_LANES, ...RECORDING_LANES].includes(name))).toEqual([]);
  expect(transcriberSyncEnabled).toBe(false);
  expect(audioCacheBootArgs.filter((tcw) => tcw !== null)).toEqual([]);
});

test("the audio cache boot and the recorder wait for Recording on the Home site", async () => {
  await mount();
  await signIn();
  const signedIn = audioCacheBootArgs.filter((tcw) => tcw !== null);
  if (HOME) {
    expect(signedIn).toEqual([]);
    expect(installEngineCalls).toBe(0);
  } else {
    expect(signedIn.length).toBeGreaterThan(0);
  }
});

test("navigation, and Recording and Connectors asking in place on the Home site", async () => {
  await mount("/chat");
  await signIn();
  if (HOME) {
    expect(navLabels()).toEqual(["Home", "Chat", "Apps", "Recording", "Connectors"]);
    for (const [path, feature, heading] of [
      ["/chat/capture", "recording", "Allow Recording"],
      ["/chat/capture/library", "recording", "Allow Recording"],
      ["/chat/connectors", "connectors", "Allow Connectors"],
    ] as const) {
      await navigate(path);
      expect(prompt(feature)?.querySelector("h2")?.textContent).toBe(heading);
      expect(host!.querySelectorAll("main").length).toBe(1);
    }
    expect(mounted).not.toContain("ConnectorsPage");
    expect(mounted).not.toContain("CaptureSurface");
    expect(mounted).not.toContain("MeetingsSection");
    expect(meetingsRequests()).toEqual([]);
    expect(reauthConfig).toBeNull();
  } else {
    expect(navLabels()).toEqual(["Recording", "Chat", "Connectors"]);
    await navigate("/chat/connectors");
    expect(mounted).toContain("ConnectorsPage");
    expect(prompt("connectors")).toBeNull();
  }
});

test("declining the in-place ask keeps the session and the feed, sets no flag, and leaves a plain retry", async () => {
  if (!HOME) return;
  reauthAnswer = "decline";
  await mount();
  await signIn();
  await navigate("/chat/capture");
  await clickInPrompt("recording", "Continue");
  expect(reauthConfig).not.toBeNull();
  expect(prompt("recording")?.textContent).toContain("Permission wasn't given. Nothing changed.");
  expect([...prompt("recording")!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Continue"]);
  expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
  expect(mounted).not.toContain("CaptureSurface");
  // The feed opens on the same session.
  await navigate("/chat/feed");
  expect(host!.querySelector('[data-testid="feed-view"]')).toBeTruthy();
  expect(tagOf(feedTcws.at(-1))).toBe("signed-in");
});

test("approving swaps in the re-authorised session in place; Recording opens, and its first successful call flags it", async () => {
  if (!HOME) return;
  await mount();
  await signIn();
  await navigate("/chat/capture");
  await clickInPrompt("recording", "Continue");
  expect(reauthConfig!.manifest).toEqual(homeSignInManifest(readManifest("manifest.home.json"), ["recording"], ADDRESS));
  expect(window.location.pathname).toBe("/chat/capture");
  expect(mounted).toContain("CaptureSurface");
  expect(JSON.parse(localStorage.getItem(FEATURES_KEY)!)).toEqual(["recording"]);
  expect(mounted).toContain("UploadResumer");
  // Connectors was not asked for, so its lanes stay off.
  expect(mounted.filter((name) => CONNECTORS_LANES.includes(name))).toEqual([]);
  // The feed opens on the re-authorised session.
  await navigate("/chat/feed");
  expect(tagOf(feedTcws.at(-1))).toBe("re-authorised");
});

test("Continue waits while an upload or a save is writing, and comes back when it ends", async () => {
  if (!HOME) return;
  await mount();
  await signIn();
  await navigate("/chat/capture");
  const write = Promise.withResolvers<void>();
  let running!: Promise<void>;
  await act(async () => { running = laneApi.runOnSpaceLane(() => write.promise); await tick(); });
  const continueButton = () => [...prompt("recording")!.querySelectorAll("button")].find((entry) => entry.textContent === "Continue")!;
  expect(continueButton().disabled).toBe(true);
  expect(prompt("recording")?.textContent).toContain("Finish the current recording or upload first.");
  await act(async () => { write.resolve(); await running; });
  await settle();
  expect(continueButton().disabled).toBe(false);
  expect(prompt("recording")?.textContent).not.toContain("Finish the current recording or upload first.");
});

test("a session saved under the broad grant is cleared once on the Home site; the plain build keeps it", async () => {
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 3_600_000, address: ADDRESS }));
  localStorage.setItem(REVISION_KEY, "4");
  await mount();
  if (HOME) {
    expect(localStorage.getItem(APP_SESSION_KEY)).toBeNull();
    expect(host!.textContent).toContain(NOTICE);
    await signIn();
    expect(localStorage.getItem(REVISION_KEY)).toBe("home-1");
    expect(host!.textContent).not.toContain(NOTICE);
  } else {
    expect(host!.textContent).not.toContain(NOTICE);
    expect(localStorage.getItem(REVISION_KEY)).toBe("4");
  }
});

test("a session already recorded under the Home revision is not asked again", async () => {
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ token: "bearer", expiresAt: Date.now() + 3_600_000, address: ADDRESS }));
  localStorage.setItem(REVISION_KEY, HOME ? "home-1" : "4");
  await mount();
  expect(host!.textContent).not.toContain(NOTICE);
});
