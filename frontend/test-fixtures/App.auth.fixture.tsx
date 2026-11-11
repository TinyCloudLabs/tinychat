import { newIdbEnv } from "@/lib/voiceNotes/web/testing/idb";
import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { __resetStorageStatusForTests, isStorageReadOnly, reportStorageError, reportStoragePlanTier,
  STORAGE_FULL_DETAIL, STORAGE_FULL_RECORDING_LINE, STORAGE_READ_ONLY_NOTICE } from "@/lib/storageStatus";

const restoreImportDom = installDom({ localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage });
const authStorage = { localStorage: window.localStorage, sessionStorage: window.sessionStorage };
const pendingVoiceNotesKey = "fixture:pending-voice-notes";
const pendingVoiceNotesCheckFailureKey = "fixture:pending-voice-notes-check-failure";
const pendingVoiceNotesDeleteFailureKey = "fixture:pending-voice-notes-delete-failure";
function setPendingVoiceNotes(recordings: Array<Record<string, unknown>>) {
  authStorage.localStorage.setItem(pendingVoiceNotesKey, JSON.stringify(recordings));
}
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
const voiceNotesApi = await import("../src/lib/voiceNotes/nativeVoiceNotes");
const storageDialogApi = await import("../src/chat/StorageFullDialog");

let nativeMode = false;
let captureInstallCalls = 0;
let captureEngineInstalled = false;
let loginAddress = "0x00000000000000000000000000000000000000a1";
let signInCalls = 0;
let lastSignInConfig: Record<string, unknown> | null = null;
let verifyCalls = 0;
let signOutStarted: (() => void) | null = null;
let releaseSignOut: (() => void) | null = null;
let lastTcw: (TinyCloudWeb & { replication?: { close: () => Promise<void>; purgeLocalCopy: () => Promise<{ ok: boolean }> } }) | null = null;
let signOutEvents: string[] = [];
let widgetSawSessionsCleared: boolean | null = null;
const deletedVoiceNoteIds: string[] = [];
let clearAppSession: (() => void) | null = null;
let cleanedClients = 0;
let restoreCalls = 0;
let restorePause = false;
let releaseRestore: (() => void) | null = null;
let restoreStarted: (() => void) | null = null;
const sessionHooks = new WeakMap<object, { handoff: () => Promise<boolean>; onCleared?: () => void }>();

function fakeTcw(address: string): TinyCloudWeb {
  const tcw = { did: `did:pkh:eip155:1:${address}`, spaceId: `space-${address.slice(-2)}`, address: () => address,
    sql: {}, kv: {}, secrets: {}, signOut: async () => { signOutEvents.push("sdk-signout"); },
    cleanup: () => { cleanedClients++; } } as unknown as TinyCloudWeb & { replication?: { close: () => Promise<void> } };
  lastTcw = tcw;
  return tcw;
}

mock.module("@tinyboilerplate/client", () => ({
  ...clientApi,
  connectWallet: async () => ({ address: loginAddress, openkey: {}, web3Provider: {} }),
  requestNonce: async () => "nonce",
  loadAppManifest: async () => ({ manifest_version: 1, app_id: "chat.tinycloud.tinychat" }),
  createAndSignIn: async (_provider: unknown, config: Record<string, unknown>) => {
    signInCalls++;
    lastSignInConfig = config;
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
  restorePersistedSession: async (sessionStore: { getAddress: () => string | null }) => {
    restoreCalls++;
    const address = sessionStore.getAddress();
    const hadStoredSession = Boolean(address
      && window.localStorage.getItem(`tinycloud:session:${address.toLowerCase()}`));
    if (restorePause) {
      restoreStarted?.();
      await new Promise<void>((resolve) => { releaseRestore = resolve; });
    }
    return address && hadStoredSession
      ? { kind: "restored", address, tcw: fakeTcw(address) }
      : { kind: "signedOut" };
  },
}));
mock.module("@/lib/sessionSignedOut", () => ({
  clearSessionAfterHandoff: async (store: { clear: () => void }) => {
    const hook = sessionHooks.get(store);
    if (hook && !await hook.handoff()) throw new Error("Couldn't stop voice recording for this account on this phone, so you're still signed in. Try again.");
    store.clear();
    hook?.onCleared?.();
  },
  registerSessionSignedOutHook: (store: object, handoff: () => Promise<boolean>, onCleared?: () => void) => {
    const hook = { handoff, onCleared };
    sessionHooks.set(store, hook);
    clearAppSession = onCleared ?? null;
    return () => {
      if (sessionHooks.get(store) === hook) sessionHooks.delete(store);
      clearAppSession = null;
    };
  },
}));
mock.module("@/lib/openkeySignOut", () => ({
  ...signOutApi,
  signOutOpenKeySession: async () => {
    signOutEvents.push("openkey-widget");
    widgetSawSessionsCleared = window.localStorage.getItem(`tinycloud:session:${loginAddress.toLowerCase()}`) === null
      && window.localStorage.getItem(`tinycloud:session:runtime-grants:${loginAddress.toLowerCase()}`) === null
      && window.localStorage.getItem("tinycloud:session:active-address") === null
      && window.localStorage.getItem("xyz.tinycloud.tinychat:session") === null;
    signOutStarted?.();
    if (releaseSignOut) await new Promise<void>((resolve) => { releaseSignOut = resolve; });
    return { status: "cancelled" };
  },
}));
mock.module("@/lib/connectors/encryptionGrant", () => ({ ...grantApi, withEncryptionDecryptGrant: (manifest: unknown) => manifest }));
mock.module("@/lib/voiceNotes/voiceNotePipeline", () => ({ ...pipelineApi, createVoiceNotePipeline: () => null }));
mock.module("../src/lib/voiceNotes/web/registerWebEngine", () => ({
  enableWebCaptureEngine: async () => { captureInstallCalls++; captureEngineInstalled = true; },
}));
mock.module("@/lib/voiceNotes/captureEngine", () => ({
  ...captureApi,
  captureCapabilities: () => ({ offlineRecorder: false, micDeniedPresentation: false }),
  captureEngineAvailable: () => captureEngineInstalled,
  subscribeCaptureCapabilities: () => () => undefined,
}));
mock.module("../src/chat/ChatWorkspace", () => ({
  ChatWorkspace: ({ settings }: { settings: React.ReactNode }) => <div data-testid="authenticated-workspace">{settings}</div>,
}));
mock.module("../src/chat/SettingsPage", () => ({
  SettingsPage: ({ onSignOut, error }: { onSignOut: () => void; error?: string | null }) => (
    <>
      {window.location.pathname === "/chat/settings" && isStorageReadOnly() && (
        <div data-testid="settings-storage-full-banner" role="region" aria-label="Storage full">
          <storageDialogApi.StorageFullMessage detail />
        </div>
      )}
      {error && <div role="alert">{error}</div>}
      <button onClick={() => void onSignOut()}>Test sign out</button>
    </>
  ),
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
mock.module("../src/capture/recorder/RecordingOverlay", () => ({ RecordingOverlay: () => null }));
mock.module("../src/capture/recorder/RecorderShell", () => ({
  RecorderShell: ({ chat, settings }: { chat: React.ReactNode; settings: React.ReactNode }) => <>{chat}{settings}</>,
}));

const nativeVoiceNotesFixture = {
  ...voiceNotesApi,
  VoiceNotes: {
    ...voiceNotesApi.VoiceNotes,
    getCaptureDefaults: async () => ({ status: "signed_out", accountDid: null, transitionGen: 0 }),
    setAccountState: async () => {},
    listPending: async () => {
      if (authStorage.localStorage.getItem(pendingVoiceNotesCheckFailureKey) === "true") {
        throw new Error("local voice-note listing failed");
      }
      return { recordings: JSON.parse(authStorage.localStorage.getItem(pendingVoiceNotesKey) ?? "[]") as Array<Record<string, unknown>> };
    },
    deleteAudio: async ({ id }: { id: string }) => {
      if (authStorage.localStorage.getItem(pendingVoiceNotesDeleteFailureKey) === "true") {
        throw new Error("local voice-note deletion failed");
      }
      deletedVoiceNoteIds.push(id);
    },
  },
};
mock.module("../src/lib/voiceNotes/nativeVoiceNotes", () => nativeVoiceNotesFixture);
mock.module("@/lib/voiceNotes/nativeVoiceNotes", () => nativeVoiceNotesFixture);
const { App } = await import("../src/App");

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  await act(async () => { await tick(); await tick(); await tick(); });
}
async function mount(platform: AppPlatform) {
  restoreDom = installDom(authStorage);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><PlatformContext.Provider value={platform}><App /></PlatformContext.Provider></BrowserRouter>));
  await settle();
  const deadline = Date.now() + 1000;
  while (!restorePause && host!.textContent?.includes("Restoring your session") && Date.now() < deadline) await settle();
}
async function remount(platform: AppPlatform) {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><PlatformContext.Provider value={platform}><App /></PlatformContext.Provider></BrowserRouter>));
  await settle();
  const deadline = Date.now() + 1000;
  while (!restorePause && host!.textContent?.includes("Restoring your session") && Date.now() < deadline) await settle();
}
async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  expect(button, `missing ${label}; DOM=${document.body.innerHTML}`).toBeTruthy();
  await act(async () => { button!.click(); await tick(); });
}
async function navigate(path: string) {
  await act(async () => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new window.Event("popstate"));
    await tick();
  });
  await settle();
}

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: newIdbEnv().factory });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: newIdbEnv().keyRange });
  authStorage.localStorage.clear();
  authStorage.sessionStorage.clear();
  nativeMode = false;
  loginAddress = "0x00000000000000000000000000000000000000a1";
  captureEngineInstalled = false;
  verifyCalls = 0;
  signOutStarted = null;
  releaseSignOut = null;
  cleanedClients = 0;
  lastTcw = null;
  signOutEvents = [];
  widgetSawSessionsCleared = null;
  authStorage.localStorage.removeItem(pendingVoiceNotesKey);
  authStorage.localStorage.removeItem(pendingVoiceNotesCheckFailureKey);
  authStorage.localStorage.removeItem(pendingVoiceNotesDeleteFailureKey);
  deletedVoiceNoteIds.length = 0;
  clearAppSession = null;
  restoreCalls = 0;
  restorePause = false;
  releaseRestore = null;
  restoreStarted = null;
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
  // One-click flow: no OpenKey authorize mode, and no app-key grants in the signed manifest.
  const config = lastSignInConfig as unknown as { openkey?: { mode?: unknown }; manifest: Record<string, unknown> };
  expect(config.openkey?.mode).toBeUndefined();
  expect(JSON.stringify(config)).not.toContain("iframe");
  expect("keys" in config.manifest).toBe(false);
  expect("keys_app_id" in config.manifest).toBe(false);

  await act(async () => { reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED", message: "full" }); await tick(); });
  expect(isStorageReadOnly()).toBe(true);
  expect(host!.textContent).toContain("Storage full");

  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  signOutStarted = started;
  releaseSignOut = () => {};
  await click("Test sign out");
  await startedPromise;
  expect(Boolean(host!.querySelector('[data-testid="authenticated-workspace"]'))).toBe(false);
  expect(host!.textContent).toContain("Sign in");
  await act(async () => { releaseSignOut?.(); releaseSignOut = null; await tick(); await tick(); });
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();
  expect(host!.textContent).toContain("You're signed out of TinyChat, but still signed in to OpenKey on this device. To use another account, sign out at openkey.so first.");
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
test("web sign-out clears SDK and app sessions before a hung OpenKey confirmation returns, then restores signed out", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  const address = loginAddress.toLowerCase();
  const did = `did:pkh:eip155:1:${loginAddress}`;
  const spaceId = `space-${loginAddress.slice(-2)}`;
  window.localStorage.setItem(`tinycloud:session:${address}`, JSON.stringify({
    address: loginAddress,
    chainId: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  window.localStorage.setItem(`tinycloud:session:runtime-grants:${address}`, "runtime grants");
  window.localStorage.setItem("tinycloud:session:active-address", address);
  window.localStorage.setItem("xyz.tinycloud.tinychat:session", JSON.stringify({
    token: "stored-session",
    expiresAt: Date.now() + 60_000,
    address: loginAddress,
  }));
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).not.toBeNull();
  expect(window.localStorage.getItem("tinycloud:session:active-address")).toBe(address);
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:session")).not.toBeNull();

  const perAddressKeys = [
    `tinychat:index:${did}`,
    `xyz.tinycloud.tinychat:manifest-revision:${address}`,
    `exo-audio-receipt-pass:${did}:${spaceId}`,
    `exo.voiceNotes.partialAudio.${encodeURIComponent(did)}.${encodeURIComponent(spaceId)}`,
  ];
  for (const key of perAddressKeys) window.localStorage.setItem(key, "account data");
  window.localStorage.setItem("xyz.tinycloud.tinychat:auth-kind", "native");
  window.localStorage.setItem("exo.capture.transitionGen", "7");
  window.localStorage.setItem("exo.voiceNotes.partialAudio.signed-out.local", "local recording");
  expect(lastTcw).toBeTruthy();
  lastTcw!.replication = {
    purgeLocalCopy: async () => { signOutEvents.push("replica-purge"); return { ok: true }; },
  };

  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  signOutStarted = started;
  releaseSignOut = () => {};
  await click("Test sign out");
  await startedPromise;
  await settle();

  expect(Boolean(host!.querySelector('[data-testid="authenticated-workspace"]'))).toBe(false);
  expect(host!.textContent).toContain("Sign in");
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).toBeNull();
  expect(window.localStorage.getItem(`tinycloud:session:runtime-grants:${address}`)).toBeNull();
  expect(window.localStorage.getItem("tinycloud:session:active-address")).toBeNull();
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:session")).toBeNull();
  expect(perAddressKeys.every((key) => window.localStorage.getItem(key) === null)).toBe(true);
  expect(window.localStorage.getItem("exo.capture.transitionGen")).toBe("7");
  expect(window.localStorage.getItem("exo.voiceNotes.partialAudio.signed-out.local")).toBe("local recording");
  expect(widgetSawSessionsCleared).toBe(true);
  expect(signOutEvents).toEqual(["sdk-signout", "openkey-widget"]);
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:auth-kind")).toBeNull();
  expect(captureInstallCalls).toBeGreaterThan(0);

  await act(async () => { releaseSignOut?.(); releaseSignOut = null; await tick(); });
  await remount("web");
  expect(Boolean(host!.querySelector('[data-testid="authenticated-workspace"]'))).toBe(false);
  expect(host!.textContent).toContain("Sign in");
});
test("a restore finishing after local sign-out cannot restore the session", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  const address = loginAddress.toLowerCase();
  window.localStorage.setItem(`tinycloud:session:${address}`, "sdk session");
  window.localStorage.setItem("tinycloud:session:active-address", address);
  window.localStorage.setItem("xyz.tinycloud.tinychat:session", JSON.stringify({
    token: "stored-session",
    expiresAt: Date.now() + 60_000,
    address: loginAddress,
  }));

  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  restorePause = true;
  restoreStarted = started;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<BrowserRouter><PlatformContext.Provider value="web"><App /></PlatformContext.Provider></BrowserRouter>);
  });
  const didStart = await Promise.race([
    startedPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  expect(didStart).toBe(true);
  expect(clearAppSession).toBeTruthy();

  await act(async () => { clearAppSession!(); await tick(); });
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).toBeNull();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();

  await act(async () => { releaseRestore?.(); releaseRestore = null; await tick(); await tick(); });
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();
  expect(host!.textContent).toContain("Sign in");
  expect(cleanedClients).toBe(1);
});

test("TC-2785 sign-out offers keep, delete and cancel and retains local-only notes on keep", async () => {
  const address = loginAddress.toLowerCase();
  const did = `did:pkh:eip155:1:${loginAddress}`;
  setPendingVoiceNotes([{
    id: "pending-note",
    owner: did,
    ledger: { audio: { state: "pending" } },
  }]);
  await mount("web");
  await click("Sign in");
  await settle();
  window.localStorage.setItem(`tinycloud:session:${address}`, "sdk session");
  window.localStorage.setItem("tinycloud:session:active-address", address);
  window.localStorage.setItem("xyz.tinycloud.tinychat:session", "app session");

  await click("Test sign out");
  await settle();
  expect(document.body.textContent).toContain("A voice note is still on this browser");
  expect(document.body.textContent).toContain("It stays on this browser for this account");
  expect(document.body.textContent).toContain("Keep & sign out");
  expect(document.body.textContent).toContain("Delete from this browser & sign out");
  expect(document.body.textContent).toContain("Stay signed in");
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).not.toBeNull();
  expect(signOutEvents).toEqual([]);
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:signout-pending")).toBeNull();
  await click("Stay signed in");
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  await click("Test sign out");
  await settle();
  await click("Keep & sign out");
  await settle();
  expect(deletedVoiceNoteIds).toEqual([]);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).toBeNull();
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:signout-pending")).toBeNull();
});
test("sign-out explains when checking whether pending voice notes are saved fails", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  authStorage.localStorage.setItem(pendingVoiceNotesCheckFailureKey, "true");
  await click("Test sign out");
  await settle();
  expect(host!.querySelector('[role="alert"]')?.textContent)
    .toBe("Couldn't check whether your voice notes are saved, so you're still signed in. Try again.");
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});

test("the pending-note dialog uses plural copy for multiple voice notes", async () => {
  const did = `did:pkh:eip155:1:${loginAddress}`;
  setPendingVoiceNotes([
    { id: "pending-note-1", owner: did, ledger: { audio: { state: "pending" } } },
    { id: "pending-note-2", owner: did, ledger: { audio: { state: "pending" } } },
  ]);
  await mount("web");
  await click("Sign in");
  await settle();
  await click("Test sign out");
  await settle();
  expect(document.body.querySelector('[data-testid="pending-voice-note-signout"]')?.textContent)
    .toContain("2 voice notes haven't been saved to your TinyCloud yet.");
  expect(document.body.querySelector('[data-testid="pending-voice-note-signout"]')?.textContent)
    .toContain("Delete from this browser & sign out");
});

test("failed pending-note deletion keeps the owner signed in with recovery copy", async () => {
  const address = loginAddress.toLowerCase();
  const did = `did:pkh:eip155:1:${loginAddress}`;
  setPendingVoiceNotes([{ id: "pending-note-delete-failure", owner: did, ledger: { audio: { state: "pending" } } }]);
  authStorage.localStorage.setItem(pendingVoiceNotesDeleteFailureKey, "true");
  await mount("web");
  await click("Sign in");
  await settle();
  window.localStorage.setItem(`tinycloud:session:${address}`, "sdk session");
  await click("Test sign out");
  await settle();
  await click("Delete from this browser & sign out");
  await settle();
  expect(document.body.querySelector('[data-testid="pending-voice-note-signout"] [role="alert"]')?.textContent)
    .toBe("Couldn't delete all your voice notes, so you're still signed in. Try again.");
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).not.toBeNull();
  expect(host!.textContent).not.toContain("You're still signed in on this tab. If you reload or close it, you'll need to sign in again.");
});

test("a failed note deletion with a retained sign-out fence reports the signed-in state", async () => {
  const address = loginAddress.toLowerCase();
  const did = `did:pkh:eip155:1:${loginAddress}`;
  setPendingVoiceNotes([{ id: "pending-note-fenced-delete", owner: did, ledger: { audio: { state: "pending" } } }]);
  authStorage.localStorage.setItem(pendingVoiceNotesDeleteFailureKey, "true");
  await mount("web");
  await click("Sign in");
  await settle();
  window.localStorage.setItem(`tinycloud:session:${address}`, "sdk session");
  await click("Test sign out");
  await settle();

  const storage = window.localStorage;
  const fenceKey = "xyz.tinycloud.tinychat:signout-pending";
  const originalRemoveItem = storage.removeItem.bind(storage);
  Object.defineProperty(storage, "removeItem", {
    configurable: true,
    value: (key: string) => {
      if (key === fenceKey) throw new Error("storage unavailable");
      originalRemoveItem(key);
    },
  });
  try {
    await click("Delete from this browser & sign out");
    await settle();
    expect(document.body.querySelector('[data-testid="pending-voice-note-signout"] [role="alert"]')?.textContent)
      .toBe("Couldn't delete all your voice notes, so you're still signed in. Try again.");
    expect(host!.textContent)
      .toContain("You're still signed in on this tab. If you reload or close it, you'll need to sign in again.");
    expect(host!.textContent)
      .not.toContain("You're signed out of TinyChat, but this device didn't finish clearing your session.");
    expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
    expect(window.localStorage.getItem(`tinycloud:session:${address}`)).not.toBeNull();
    expect(window.localStorage.getItem(fenceKey)).not.toBeNull();
  } finally {
    Object.defineProperty(storage, "removeItem", { configurable: true, value: originalRemoveItem });
  }
});

test("sign-out recovery copy distinguishes a local-clear failure from an unfinished SDK cleanup", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  const storage = window.localStorage;
  const fenceKey = "xyz.tinycloud.tinychat:signout-pending";
  const originalSetItem = storage.setItem.bind(storage);
  Object.defineProperty(storage, "setItem", {
    configurable: true,
    value: (key: string, value: string) => {
      if (key === fenceKey) throw new Error("storage unavailable");
      originalSetItem(key, value);
    },
  });
  try {
    await click("Test sign out");
    await settle();
    expect(host!.querySelector('[role="alert"]')?.textContent)
      .toBe("Couldn't sign you out on this device. You're still signed in. Try again.");
    expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  } finally {
    Object.defineProperty(storage, "setItem", { configurable: true, value: originalSetItem });
  }

  lastTcw!.signOut = async () => { throw new Error("SDK cleanup failed"); };
  await click("Test sign out");
  await settle();
  expect(host!.textContent)
    .toContain("You're signed out of TinyChat, but this device didn't finish clearing your session. Sign in again, then sign out.");

  const originalRemoveItem = storage.removeItem.bind(storage);
  Object.defineProperty(storage, "removeItem", {
    configurable: true,
    value: (key: string) => {
      if (key === fenceKey) throw new Error("storage unavailable");
      originalRemoveItem(key);
    },
  });
  try {
    await click("Sign in");
    await settle();
    expect(host!.textContent)
      .toContain("Sign-out didn't finish on this device. Sign in again, then sign out.");
  } finally {
    Object.defineProperty(storage, "removeItem", { configurable: true, value: originalRemoveItem });
  }
});

test("a delayed SDK session write after a hung sign-out cannot restore across reloads", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  const address = loginAddress.toLowerCase();
  const appSession = JSON.stringify({ token: "app-session", expiresAt: Date.now() + 60_000, address: loginAddress });
  window.localStorage.setItem("xyz.tinycloud.tinychat:session", appSession);
  const restoresBeforeSignOut = restoreCalls;
  lastTcw!.signOut = () => new Promise<void>(() => {});
  let releaseLateWrite!: () => void;
  const lateWrite = new Promise<void>((resolve) => {
    releaseLateWrite = () => {
      window.localStorage.setItem(`tinycloud:session:${address}`, "late SDK session");
      window.localStorage.setItem("tinycloud:session:active-address", address);
      window.localStorage.setItem("xyz.tinycloud.tinychat:session", appSession);
      resolve();
    };
  });

  await click("Test sign out");
  await settle();
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:signout-pending")).not.toBeNull();
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).toBeNull();

  jest.useFakeTimers();
  try {
    await act(async () => {
      jest.advanceTimersByTime(5_100);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    });
  } finally {
    jest.useRealTimers();
  }

  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:session")).toBeNull();
  await remount("web");
  expect(restoreCalls).toBe(restoresBeforeSignOut);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeNull();
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).toBeNull();
  expect(window.localStorage.getItem("tinycloud:session:active-address")).toBeNull();

  // A storage write that began before logout may finish after the first new App boot.
  releaseLateWrite();
  await lateWrite;
  await remount("web");
  expect(restoreCalls).toBe(restoresBeforeSignOut);
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:session")).toBeNull();
  expect(window.localStorage.getItem(`tinycloud:session:${address}`)).toBeNull();
  expect(window.localStorage.getItem("tinycloud:session:active-address")).toBeNull();

  loginAddress = "0x00000000000000000000000000000000000000b2";
  await click("Sign in");
  await settle();
  const otherAddress = loginAddress.toLowerCase();
  window.localStorage.setItem(`tinycloud:session:${otherAddress}`, "new account session");
  window.localStorage.setItem("tinycloud:session:active-address", otherAddress);
  window.localStorage.setItem("xyz.tinycloud.tinychat:session", JSON.stringify({
    token: "account-b-session",
    expiresAt: Date.now() + 60_000,
    address: loginAddress,
  }));
  const restoresBeforeOtherAccount = restoreCalls;
  await remount("web");
  expect(restoreCalls).toBe(restoresBeforeOtherAccount + 1);
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:signout-pending")).toContain(address);
});


test("native interactive sign-in mounts the authenticated workspace", async () => {
  nativeMode = true;
  await mount("ios");
  expect(host!.querySelector('[data-testid="native-sign-in"]')).toBeTruthy();
  await click("Continue with Google");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});

test("mounted App shows one shared read-only notice outside Settings and keeps Settings detail there", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  await act(async () => {
    reportStoragePlanTier("free");
    reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED", message: "full" });
    await tick();
  });

  const globalNotice = host!.querySelector('[data-testid="app-storage-read-only-notice"]');
  expect(globalNotice?.textContent).toContain(STORAGE_READ_ONLY_NOTICE);
  expect(globalNotice?.textContent).not.toContain(STORAGE_FULL_RECORDING_LINE);
  expect(host!.querySelectorAll('[aria-label="Storage full"]')).toHaveLength(1);

  await navigate("/chat/settings");
  expect(host!.querySelector('[data-testid="app-storage-read-only-notice"]')).toBeNull();
  const settingsBanner = host!.querySelector('[data-testid="settings-storage-full-banner"]');
  expect(settingsBanner?.textContent).toContain(STORAGE_FULL_DETAIL.free);
  expect(host!.querySelectorAll('[aria-label="Storage full"]')).toHaveLength(1);
});


test("TC-2785 native iOS retains the blocking Save/Delete flow until its ownership port", async () => {
  const did = `did:pkh:eip155:1:${loginAddress}`;
  setPendingVoiceNotes([{ id: "ios-only-copy", owner: did, ledger: { audio: { state: "pending" } } }]);
  await mount("ios");
  await click("Sign in");
  await settle();
  await click("Test sign out");
  await settle();
  expect(document.body.textContent).toContain("Save and sign out");
  expect(document.body.textContent).not.toContain("Keep & sign out");
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
});

test("TC-2785 a local-result clear failure releases the sign-out fence and keeps the session", async () => {
  await mount("web");
  await click("Sign in");
  await settle();
  const factory = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open(name: string, version?: number) {
      if (name === "exo-held-results") throw new Error("device storage unavailable");
      return factory.open(name, version);
    },
  } });
  await click("Test sign out");
  await settle();
  expect(host!.querySelector('[data-testid="authenticated-workspace"]')).toBeTruthy();
  expect(window.localStorage.getItem("xyz.tinycloud.tinychat:signout-pending")).toBeNull();
  expect(signOutEvents).toEqual([]);
});
