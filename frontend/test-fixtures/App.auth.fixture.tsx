import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { __resetStorageStatusForTests, isStorageReadOnly, reportStorageError } from "@/lib/storageStatus";

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

let nativeMode = false;
let loginAddress = "0x00000000000000000000000000000000000000a1";
let signInCalls = 0;
let verifyCalls = 0;
let signOutStarted: (() => void) | null = null;
let releaseSignOut: (() => void) | null = null;

function fakeTcw(address: string): TinyCloudWeb {
  return { did: `did:pkh:eip155:1:${address}`, spaceId: `space-${address.slice(-2)}`, address: () => address,
    sql: {}, kv: {}, secrets: {} } as unknown as TinyCloudWeb;
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: loginAddress, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  loadAppManifest: async () => ({}),
  createAndSignIn: async () => {
    signInCalls++;
    return { tcw: fakeTcw(loginAddress), session: { siwe: "message", signature: "signature" } };
  },
  verifySession: async () => {
    verifyCalls++;
    return { token: "bearer", expiresIn: 3600, address: loginAddress };
  },
}));
mock.module("@/lib/openkeyNative", () => ({
  ...nativeApi,
  isNativeOpenKeySignIn: () => nativeMode,
  isNativeOpenKeySession: () => nativeMode,
  restoreNativeAtBoot: async () => ({ kind: "none" }),
  signInNative: async () => ({
    verified: { address: loginAddress, token: "native-bearer", expiresIn: 3600 },
    session: {}, openkey: {}, tcw: fakeTcw(loginAddress),
  }),
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
  restorePersistedSession: async () => ({ kind: "signedOut" }),
}));
mock.module("@/lib/openkeySignOut", () => ({
  ...signOutApi,
  signOutOpenKeySession: async () => {
    signOutStarted?.();
    if (releaseSignOut) await new Promise<void>((resolve) => { releaseSignOut = resolve; });
    return { status: "cancelled" };
  },
}));
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
mock.module("../src/chat/SettingsPage", () => ({
  SettingsPage: ({ onSignOut }: { onSignOut: () => void }) => <button onClick={() => void onSignOut()}>Test sign out</button>,
}));
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
async function mount(platform: AppPlatform) {
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

beforeEach(() => {
  nativeMode = false;
  loginAddress = "0x00000000000000000000000000000000000000a1";
  signInCalls = 0;
  verifyCalls = 0;
  signOutStarted = null;
  releaseSignOut = null;
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
afterAll(() => { mock.restore(); restoreImportDom(); });

test("browser sign-in mounts the workspace; committed A sign-out clears storage UI before B becomes ready", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  expect(signInCalls).toBe(1);
  expect(verifyCalls).toBe(1);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();

  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  signOutStarted = started;
  releaseSignOut = () => {};
  await click("Test sign out");
  await startedPromise;
  await act(async () => { reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED", message: "full" }); await tick(); });
  expect(isStorageReadOnly()).toBe(true);
  expect(host!.textContent).toContain("Storage full");
  await act(async () => { releaseSignOut?.(); releaseSignOut = null; await tick(); await tick(); });
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();
  expect(host!.textContent).not.toContain("Storage full");
  expect(isStorageReadOnly()).toBe(false);

  loginAddress = "0x00000000000000000000000000000000000000b2";
  await click("Sign in");
  await settle();
  expect(signInCalls).toBe(2);
  expect(verifyCalls).toBe(2);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(host!.textContent).not.toContain("Storage full");
  await click("Test sign out");
  await settle();
  loginAddress = "0x00000000000000000000000000000000000000a1";
  await click("Sign in");
  await settle();
  expect(signInCalls).toBe(3);
  expect(verifyCalls).toBe(3);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(host!.textContent).not.toContain("Storage full");
});

test("native interactive sign-in mounts the authenticated workspace", async () => {
  nativeMode = true;
  await mount("ios");
  expect(host!.querySelector('[data-testid="native-sign-in"]')).toBeTruthy();
  await click("Continue with Google");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});
