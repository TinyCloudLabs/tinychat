import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { AgentAccessProvider } from "./useAgentEnablement";
import { appPlatform, PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";

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
  expect(page.querySelector('label[for="upload-audio-to-tinycloud"]')?.textContent).toBe("Upload audio to TinyCloud");
  expect(page.textContent).toContain("Browsers can delete it. Turn on Upload audio to keep a copy in TinyCloud.");
});
