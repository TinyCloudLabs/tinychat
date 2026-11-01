import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { BillingStatus } from "@/lib/billingApi";
import { __resetStorageStatusForTests, reportStorageError, reportStoragePlanTier, STORAGE_FULL_DETAIL, STORAGE_READ_ONLY_NOTICE } from "@/lib/storageStatus";

import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { AgentAccessProvider } from "./useAgentEnablement";
import { appPlatform, PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { setUploadAudioPreference } from "@/lib/voiceNotes/transcriberPreference";

let cleanDom: (() => void) | undefined;
let previousCustomElements: PropertyDescriptor | undefined;

beforeAll(() => {
  cleanDom = installDom();
  previousCustomElements = Object.getOwnPropertyDescriptor(globalThis, "customElements");
  Object.defineProperty(globalThis, "customElements", { configurable: true, value: window.customElements });
});
afterAll(() => {
  __setVoiceNotesForTests(null, { available: null });
  if (previousCustomElements) Object.defineProperty(globalThis, "customElements", previousCustomElements);
  else Reflect.deleteProperty(globalThis, "customElements");
  cleanDom?.();
});

test("signed-in web Settings shows the audio upload switch and browser storage warning", async () => {
  // Web has no native capture plugin. The setting must still be reachable through Settings.
  __setVoiceNotesForTests(null, { available: false });
  expect(appPlatform()).toBe("web");
  await setUploadAudioPreference(false);
  const { SettingsPage } = await import("./SettingsPage");
  const tcw = {
    did: "did:example:account",
    spaceId: "space-1",
    address: () => "0x00000000000000000000000000000000000000a1",
  } as unknown as TinyCloudWeb;
  const sessionStore = { getToken: () => "signed-in-token" } as unknown as SessionStore;
  const noop = () => {};
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value="web">
        <StaticRecorderProvider value={{ signedIn: true, available: false }}>
          <AgentAccessProvider backendUrl="http://localhost" sessionStore={sessionStore} tcw={tcw} appName="Exo" openkeyHost="http://localhost">
            <SettingsPage
              address={tcw.address()} did={tcw.did} spaceId={tcw.spaceId} state="ready" error={null}
              onSignOut={noop} signingOut={false} paywallEnabled={false} onBack={noop}
              tcw={tcw} memoryRef={createRef<string | null>()} onMemoryUpdated={noop} onImported={noop}
              billingStatus={null} billingTierName={null} onManagePlan={noop} onOpenRates={noop}
              backendUrl="http://localhost" sessionStore={sessionStore}
            />
          </AgentAccessProvider>
        </StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>,
  );

  const page = document.createElement("div");
  page.innerHTML = markup;
  expect(page.textContent).toContain("Voice notes");
  expect(page.querySelector('input[type="checkbox"]#upload-audio-to-tinycloud')).not.toBeNull();
  expect([...page.querySelectorAll('label[for="upload-audio-to-tinycloud"]')].some((label) => label.textContent === "Upload audio to TinyCloud")).toBe(true);
  expect(page.textContent).toContain("Audio stays in this browser, and browsers can delete it. Turn this on to keep a copy in TinyCloud.");
});

test("Mac Settings shows the Voice notes card with Stop recording after and the upload switch, without the default transcriber", async () => {
  __setVoiceNotesForTests(null, { available: false });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  try {
    expect(appPlatform()).toBe("tauri");
    // Loaded after beforeAll installs the DOM, as the web test above does.
    const { SettingsPage } = await import("./SettingsPage");
    const tcw = { did: "did:example:account", spaceId: "space-1", address: () => "0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
    const sessionStore = { getToken: () => "signed-in-token" } as unknown as SessionStore;
    const noop = () => {};
    const page = document.createElement("div");
    page.innerHTML = renderToStaticMarkup(
      <MemoryRouter>
        <PlatformContext.Provider value="tauri">
          <StaticRecorderProvider value={{ signedIn: true, available: true }}>
            <AgentAccessProvider backendUrl="http://localhost" sessionStore={sessionStore} tcw={tcw} appName="Exo" openkeyHost="http://localhost">
              <SettingsPage
                address={tcw.address()} did={tcw.did} spaceId={tcw.spaceId} state="ready" error={null}
                onSignOut={noop} signingOut={false} paywallEnabled={false} onBack={noop}
                tcw={tcw} memoryRef={createRef<string | null>()} onMemoryUpdated={noop} onImported={noop}
                billingStatus={null} billingTierName={null} onManagePlan={noop} onOpenRates={noop}
                backendUrl="http://localhost" sessionStore={sessionStore}
              />
            </AgentAccessProvider>
          </StaticRecorderProvider>
        </PlatformContext.Provider>
      </MemoryRouter>,
    );
    const stopAfter = page.querySelector('[data-testid="voice-notes-stop-after"]');
    expect(stopAfter?.textContent).toContain("Stop recording after");
    expect([...stopAfter!.querySelectorAll("option")].map((option) => option.textContent))
      .toEqual(["15 min", "30 min", "1 h", "2 h", "Off (3-hour limit)"]);
    expect(stopAfter!.querySelector("option[selected]")?.textContent).toBe("1 h");
    expect(page.querySelectorAll('[data-testid="voice-notes-stop-after"]')).toHaveLength(1);
    expect(page.querySelector('input[type="checkbox"]#upload-audio-to-tinycloud')).not.toBeNull();
    expect(page.querySelector('[aria-label="Default transcriber"]')).toBeNull();
  } finally {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
});

test("mounted Settings keeps the agent-access block and one detailed storage notice", async () => {
  __setVoiceNotesForTests(null, { available: false });
  __resetStorageStatusForTests();
  reportStoragePlanTier("free");
  reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED" });

  const { SettingsPage } = await import("./SettingsPage");
  const tcw = {
    did: "did:example:account",
    spaceId: "space-1",
    address: () => "0x00000000000000000000000000000000000000a1",
  } as unknown as TinyCloudWeb;
  const sessionStore = { getToken: () => "signed-in-token" } as unknown as SessionStore;
  const noop = () => {};
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);

  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <PlatformContext.Provider value="web">
            <StaticRecorderProvider value={{ signedIn: true, available: false }}>
              <AgentAccessProvider backendUrl="http://localhost" sessionStore={sessionStore} tcw={tcw} appName="Exo" openkeyHost="http://localhost">
                <SettingsPage
                  address={tcw.address()} did={tcw.did} spaceId={tcw.spaceId} state="ready" error={null}
                  onSignOut={noop} signingOut={false} paywallEnabled={false} onBack={noop}
                  tcw={tcw} memoryRef={createRef<string | null>()} onMemoryUpdated={noop} onImported={noop}
                  billingStatus={null} billingTierName={null} onManagePlan={noop} onOpenRates={noop}
                  backendUrl="http://localhost" sessionStore={sessionStore}
                />
              </AgentAccessProvider>
            </StaticRecorderProvider>
          </PlatformContext.Provider>
        </MemoryRouter>,
      );
    });

    const storageRegions = host.querySelectorAll('[role="region"][aria-label="Storage full"]');
    expect(storageRegions).toHaveLength(1);
    expect(storageRegions[0]?.textContent).toContain(STORAGE_FULL_DETAIL.free);
    expect(host.textContent).not.toContain(STORAGE_READ_ONLY_NOTICE);
    expect(host.querySelector("#agent-access")?.textContent).toContain("Agent access");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    __resetStorageStatusForTests();
  }
});

test("Conversation Canvas toggle is off by default under Experimental Features for an eligible account", async () => {
  __setVoiceNotesForTests(null, { available: false });
  // Loaded after beforeAll installs the DOM, as the tests above do.
  const { SettingsPage } = await import("./SettingsPage");
  const tcw = {
    did: "did:example:account",
    spaceId: "space-1",
    address: () => "0x00000000000000000000000000000000000000a1",
  } as unknown as TinyCloudWeb;
  const sessionStore = { getToken: () => "signed-in-token" } as unknown as SessionStore;
  const billingStatus: BillingStatus = { tier: "free", usage: { used: 0, limit: 0, resetsAt: "" }, subscription: null };
  const noop = () => {};
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value="web">
        <StaticRecorderProvider value={{ signedIn: true, available: false }}>
          <AgentAccessProvider backendUrl="http://localhost" sessionStore={sessionStore} tcw={tcw} appName="Exo" openkeyHost="http://localhost">
            <SettingsPage
              address={tcw.address()} did={tcw.did} spaceId={tcw.spaceId} state="ready" error={null}
              onSignOut={noop} signingOut={false} paywallEnabled={false} onBack={noop}
              tcw={tcw} memoryRef={createRef<string | null>()} onMemoryUpdated={noop} onImported={noop}
              billingStatus={billingStatus} billingTierName={null} onManagePlan={noop} onOpenRates={noop}
              backendUrl="http://localhost" sessionStore={sessionStore}
            />
          </AgentAccessProvider>
        </StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>,
  );

  const page = document.createElement("div");
  page.innerHTML = markup;
  expect(page.textContent).toContain("Experimental Features");
  const toggle = page.querySelector('button[aria-label="Enable Conversation Canvas"]');
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute("role")).toBe("switch");
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
});

afterEach(() => __resetStorageStatusForTests());
