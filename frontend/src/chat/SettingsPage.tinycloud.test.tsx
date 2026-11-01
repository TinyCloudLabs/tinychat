import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { AgentAccessProvider } from "./useAgentEnablement";

let cleanDom: (() => void) | undefined;
beforeAll(() => { cleanDom = installDom(); });
afterAll(() => cleanDom?.());

test("Settings has a TinyCloud section with the button toggle and the panel row", async () => {
  const { SettingsPage } = await import("./SettingsPage");
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
  const section = [...page.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "TinyCloud");
  expect(section).toBeDefined();
  expect(section!.textContent).toContain("Show the TinyCloud button");
  expect(section!.textContent).toContain("TinyCloud panel");
  expect(section!.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
});
