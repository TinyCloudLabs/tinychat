import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext } from "@/lib/platform";

const restoreImportDom = installDom();
const clientApi = await import("@tinyboilerplate/client");
const nativeApi = await import("@/lib/openkeyNative");
const restoreApi = await import("@/lib/sessionRestore");
const pipelineApi = await import("@/lib/voiceNotes/voiceNotePipeline");
const grantApi = await import("@/lib/connectors/encryptionGrant");
const captureApi = await import("@/lib/voiceNotes/captureEngine");
const agentEnablementApi = await import("@/chat/useAgentEnablement");
const transcriberSyncApi = await import("@/chat/useTranscriberLibrarySync");
const recorderProviderApi = await import("@/capture/recorder/RecorderProvider");
const uploadResumerApi = await import("@/capture/upload/UploadResumer");

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const APPROVE = "Continue to OpenKey";
let signInCalls = 0;
/** Rejections for the next `signIn` calls, consumed in order; an empty list means success. */
let signInFailures: unknown[] = [];
/** Makes the Nth `prepareSignIn` call reject. */
let prepareFailsOnCall: { call: number; error: unknown } | null = null;
/** Mirrors web-sdk performSignIn: `prepareSignIn` stores a prepared session, `signIn` consumes it before OpenKey is called. */
let prepared = false;
let prepareCalls = 0;
/** For each `signIn` call, whether it found a prepared session (the route that requests OpenKey's popup synchronously). */
let signInUsedPrepared: boolean[] = [];
let events: string[] = [];

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
    prepareSignIn: async () => {
      prepareCalls++;
      events.push("prepareSignIn");
      if (prepareFailsOnCall?.call === prepareCalls) throw prepareFailsOnCall.error;
      prepared = true;
    },
    signIn: async () => {
      signInCalls++;
      events.push(`signIn:${prepared ? "prepared" : "fresh"}`);
      signInUsedPrepared.push(prepared);
      prepared = false;
      if (signInFailures.length > 0) throw signInFailures.shift();
      return { siwe: "message", signature: "signature" };
    },
  }),
  verifySession: async () => ({ token: "bearer", expiresIn: 3600, address: ADDRESS }),
}));
mock.module("@/lib/openkeyNative", () => ({
  ...nativeApi,
  isNativeOpenKeySignIn: () => false,
  isNativeOpenKeySession: () => false,
  restoreNativeAtBoot: async () => ({ kind: "none" }),
  secretsAvailable: () => false,
}));
mock.module("@/lib/sessionRestore", () => ({
  ...restoreApi,
  browserIsOffline: () => false,
  restorePersistedSession: async () => ({ kind: "signedOut" }),
}));
mock.module("@/lib/connectors/encryptionGrant", () => ({ ...grantApi, withEncryptionDecryptGrant: (manifest: unknown) => manifest }));
mock.module("@/lib/voiceNotes/voiceNotePipeline", () => ({ ...pipelineApi, createVoiceNotePipeline: () => null }));
mock.module("@/lib/voiceNotes/captureEngine", () => ({
  ...captureApi,
  captureCapabilities: () => ({ offlineRecorder: false, micDeniedPresentation: false }),
  captureEngineAvailable: () => false,
}));
mock.module("../src/chat/ChatWorkspace", () => ({
  ChatWorkspace: () => <div data-testid="authenticated-workspace" />,
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
function button(label: string): HTMLButtonElement | undefined {
  return [...host!.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
}
async function press(label: string) {
  const target = button(label);
  expect(target, `missing ${label}; DOM=${host!.innerHTML}`).toBeTruthy();
  await act(async () => { target!.click(); await tick(); });
  await settle();
}
/** `undefined` removes `navigator.userActivation`, as in a browser without the API. */
function setUserActivation(isActive: boolean | undefined) {
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: isActive === undefined ? undefined : { isActive, hasBeenActive: isActive } });
}
async function mountSignedOut() {
  restoreDom = installDom();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<BrowserRouter><PlatformContext.Provider value="web"><App /></PlatformContext.Provider></BrowserRouter>));
  await settle();
}

beforeEach(() => {
  signInCalls = 0;
  signInFailures = [];
  prepareFailsOnCall = null;
  prepared = false;
  prepareCalls = 0;
  signInUsedPrepared = [];
  events = [];
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  restoreDom?.();
  restoreDom = undefined;
});
afterAll(() => { mock.restore(); restoreImportDom(); });

const workspaceShown = () => host!.querySelector('[data-testid="authenticated-workspace"]') !== null;

test("active user activation: sign-in opens OpenKey directly, no approval screen", async () => {
  await mountSignedOutActivation(true);
  await press("Sign in");
  expect(button(APPROVE)).toBeUndefined();
  expect(signInCalls).toBe(1);
  expect(workspaceShown()).toBe(true);
});

test("lapsed user activation: the approval screen shows and sign-in runs only after its click", async () => {
  await mountSignedOutActivation(false);
  await press("Sign in");
  expect(button(APPROVE)).toBeTruthy();
  expect(signInCalls).toBe(0);
  await press(APPROVE);
  expect(signInCalls).toBe(1);
  expect(workspaceShown()).toBe(true);
});

test("navigator.userActivation unsupported: the approval screen shows", async () => {
  await mountSignedOutActivation(undefined);
  await press("Sign in");
  expect(button(APPROVE)).toBeTruthy();
  expect(signInCalls).toBe(0);
  await press(APPROVE);
  expect(signInCalls).toBe(1);
  expect(workspaceShown()).toBe(true);
});

test("popup blocked on the direct path: the approval screen shows without an error, then its click signs in", async () => {
  signInFailures = [{ code: "POPUP_BLOCKED", message: "Popup was blocked. Please allow popups for this site." }];
  await mountSignedOutActivation(true);
  await press("Sign in");
  expect(signInCalls).toBe(1);
  expect(button(APPROVE)).toBeTruthy();
  expect(host!.textContent).not.toContain("Couldn't sign in");
  expect(workspaceShown()).toBe(false);
  await press(APPROVE);
  expect(signInCalls).toBe(2);
  expect(workspaceShown()).toBe(true);
});

test("popup blocked on the direct path: the fallback click signs in on a prepared session", async () => {
  signInFailures = [{ code: "POPUP_BLOCKED", message: "Popup was blocked. Please allow popups for this site." }];
  await mountSignedOutActivation(true);
  await press("Sign in");
  // The blocked call consumed the first preparation; the screen waits for a second one.
  expect(prepareCalls).toBe(2);
  expect(button(APPROVE)).toBeTruthy();
  events.push("click");
  await press(APPROVE);
  expect(events).toEqual(["prepareSignIn", "signIn:prepared", "prepareSignIn", "click", "signIn:prepared"]);
  expect(signInUsedPrepared).toEqual([true, true]);
  expect(workspaceShown()).toBe(true);
});

test("popup blocked, then the second preparation fails: the sign-in error shows and no screen is offered", async () => {
  signInFailures = [{ code: "POPUP_BLOCKED", message: "Popup was blocked. Please allow popups for this site." }];
  prepareFailsOnCall = { call: 2, error: new Error("prepare boom") };
  await mountSignedOutActivation(true);
  await press("Sign in");
  expect(signInCalls).toBe(1);
  expect(prepareCalls).toBe(2);
  expect(button(APPROVE)).toBeUndefined();
  expect(host!.textContent).toContain("Couldn't sign in");
  expect(workspaceShown()).toBe(false);
});

test("a direct sign-in failure other than a blocked popup is reported, not retried behind a screen", async () => {
  signInFailures = [new Error("boom")];
  await mountSignedOutActivation(true);
  await press("Sign in");
  expect(signInCalls).toBe(1);
  expect(button(APPROVE)).toBeUndefined();
  expect(host!.textContent).toContain("Couldn't sign in");
});

async function mountSignedOutActivation(isActive: boolean | undefined) {
  await mountSignedOut();
  setUserActivation(isActive);
}
