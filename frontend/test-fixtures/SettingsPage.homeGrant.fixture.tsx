// The REAL SettingsPage, by build: the sections that only serve Recording, Connectors and meeting access are
// hidden on the Home site. Run by src/chat/SettingsPage.homeGrant.test.ts in its own process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";

const HOME = process.env.VITE_HOME_SITE === "true";

let cleanDom: (() => void) | undefined;
beforeAll(() => {
  cleanDom = installDom();
  Object.defineProperty(globalThis, "customElements", { configurable: true, value: window.customElements });
});
afterAll(() => { cleanDom?.(); });

test("Settings sections that only serve dropped features", async () => {
  const { SettingsPage } = await import("@/chat/SettingsPage");
  const { AgentAccessProvider } = await import("@/chat/useAgentEnablement");
  const tcw = { did: "did:example:account", spaceId: "space-1", address: () => "0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
  const sessionStore = { getToken: () => "signed-in-token" } as unknown as SessionStore;
  const noop = () => {};
  const page = document.createElement("div");
  page.innerHTML = renderToStaticMarkup(
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
  const hidden = {
    "Agent access card": page.querySelector("#agent-access"),
    "Transcription card": [...page.querySelectorAll("h2")].find((heading) => heading.textContent === "Transcription"),
    "Meeting summaries card": [...page.querySelectorAll("h2")].find((heading) => heading.textContent === "Meeting summaries"),
    "Voice notes card": [...page.querySelectorAll("h2")].find((heading) => heading.textContent === "Voice notes"),
    "Conversation Canvas switch": page.querySelector('[data-testid="canvas-setting-row"]'),
    "Local copy (replication) card": page.querySelector('[data-testid="replication-settings"]'),
  };
  const shown = Object.entries(hidden).filter(([, element]) => element).map(([name]) => name);
  if (HOME) expect(shown).toEqual([]);
  else expect(shown.length).toBeGreaterThan(0);
  // What Chat and Home still use stays.
  const titles = [...page.querySelectorAll("h2")].map((heading) => heading.textContent);
  expect(titles).toContain("Memory");
  expect(titles).toContain("Data");
});
