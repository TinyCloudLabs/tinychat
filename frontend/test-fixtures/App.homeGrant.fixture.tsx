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
const agentEnablementApi = await import("@/chat/useAgentEnablement");
const drainApi = await import("@/chat/useBackgroundDrain");
const transcriberSyncApi = await import("@/chat/useTranscriberLibrarySync");
const recorderProviderApi = await import("@/capture/recorder/RecorderProvider");
const appShellApi = await import("@/shell/AppShell");

let lastSignInConfig: { manifest: unknown; includeAccountRegistryPermissions?: unknown } | null = null;
let decryptGrantCalls = 0;
let delegationCalls = 0;
let transcriberSyncEnabled: boolean | null = null;
const mounted: string[] = [];

function fakeTcw(): TinyCloudWeb {
  return { did: `did:pkh:eip155:1:${ADDRESS}`, spaceId: "space-a1", address: () => ADDRESS, sql: {}, kv: {}, secrets: {} } as unknown as TinyCloudWeb;
}
function spy(name: string) {
  return function Spy() { mounted.push(name); return null; };
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: ADDRESS, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  createAndSignIn: async (_provider: unknown, config: typeof lastSignInConfig) => {
    lastSignInConfig = config;
    return { tcw: fakeTcw(), session: { siwe: "message", signature: "signature" } };
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
mock.module("../src/chat/PendingVoiceNotesSaver", () => ({ PendingVoiceNotesSaver: spy("PendingVoiceNotesSaver") }));
mock.module("../src/capture/recorder/RecordingOverlay", () => ({ RecordingOverlay: spy("RecordingOverlay") }));
mock.module("../src/chat/ConnectorsPage", () => ({ ConnectorsPage: spy("ConnectorsPage") }));
mock.module("../src/capture/CaptureSurface", () => ({ CaptureSurface: spy("CaptureSurface") }));
mock.module("../src/chat/MeetingsSection", () => ({ MeetingsSection: spy("MeetingsSection") }));
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
// The real frame, so the navigation and the pointer are the real ones.
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
  transcriberSyncEnabled = null;
  mounted.length = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: memoryLocalStorage() });
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
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

test("the recording, connector and transcript lanes run only on the plain build", async () => {
  await mount();
  await signIn();
  const lanes = ["BackgroundDrainer", "GmeetSessionSync", "BackendReconciler", "UploadResumer"];
  if (HOME) {
    expect(mounted.filter((name) => lanes.includes(name))).toEqual([]);
    expect(transcriberSyncEnabled).toBe(false);
  } else {
    for (const lane of lanes) expect(mounted).toContain(lane);
    expect(transcriberSyncEnabled).toBe(true);
  }
  expect(mounted).not.toContain("PendingVoiceNotesSaver");
  expect(mounted).not.toContain("RecordingOverlay");
});

test("navigation and the Recording and Connectors screens", async () => {
  await mount("/chat");
  await signIn();
  if (HOME) {
    expect(navLabels()).toEqual(["Home", "Chat", "Apps"]);
    for (const path of ["/chat/connectors", "/chat/capture", "/chat/capture/library", "/chat/capture/library/note-1"]) {
      await navigate(path);
      expect(host!.textContent).toContain("This is on tinycloud.chat");
      expect(host!.textContent).toContain("Recording and Connectors are part of TinyCloud Chat.");
      const link = [...host!.querySelectorAll("a")].find((entry) => entry.textContent === "Open on tinycloud.chat")!;
      expect(link.getAttribute("href")).toBe(`https://tinycloud.chat${path}`);
      expect(host!.querySelectorAll("main").length).toBe(1);
    }
    expect(mounted).not.toContain("ConnectorsPage");
    expect(mounted).not.toContain("CaptureSurface");
    expect(mounted).not.toContain("MeetingsSection");
  } else {
    expect(navLabels()).toEqual(["Recording", "Chat", "Connectors"]);
    await navigate("/chat/connectors");
    expect(mounted).toContain("ConnectorsPage");
    expect(host!.textContent).not.toContain("This is on tinycloud.chat");
  }
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
