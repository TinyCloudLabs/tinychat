// The REAL SettingsPage, mounted with its effects running, by build: the sections that only serve Recording,
// Connectors and meeting access are hidden on the Home site, and nothing in it reaches for a capture engine the
// Home site does not have. Run by src/chat/SettingsPage.homeGrant.test.ts in its own process.
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";

const HOME = process.env.VITE_HOME_SITE === "true";

// Every card Settings shows, in order. A lost or added card fails the test. The Home build drops the cards that only
// serve Recording, Connectors and meeting access (and Audio storage, which needs the capture engine it does not have),
// and shows its own "Home" card, because Apps and Feed are on there by default.
const PLAIN_CARDS = [
  "Account", "Agent access", "Use with your agent", "Memory", "Transcription", "Word fixes", "Meeting summaries",
  "Voice notes", "Infrastructure", "Audio storage", "Data", "TinyCloud", "Appearance", "Experimental Features",
];
const HOME_CARDS = ["Account", "Home", "Memory", "Word fixes", "Infrastructure", "Data", "TinyCloud", "Appearance", "Experimental Features"];

let cleanDom: (() => void) | undefined;
let installCalls = 0;
beforeAll(async () => {
  cleanDom = installDom();
  Object.defineProperty(globalThis, "customElements", { configurable: true, value: window.customElements });
  const captureApi = await import("@/lib/voiceNotes/captureEngine");
  // Taken before the mock is installed: a module namespace is live, so reading it later returns the mock.
  const realInstall = captureApi.installCaptureEngine;
  mock.module("@/lib/voiceNotes/captureEngine", () => ({
    ...captureApi,
    installCaptureEngine: (...args: Parameters<typeof realInstall>) => { installCalls += 1; return realInstall(...args); },
  }));
});
afterEach(() => { installCalls = 0; });
afterAll(() => { mock.restore(); cleanDom?.(); });

test("Settings cards, and nothing that needs a capture engine, by build", async () => {
  const { SettingsPage } = await import("@/chat/SettingsPage");
  const { AgentAccessProvider } = await import("@/chat/useAgentEnablement");
  // An empty space: every read answers with no rows, so no card fails for a reason unrelated to the build.
  const emptyDb = { query: async () => ({ ok: true, data: { columns: [], rows: [] } }), execute: async () => ({ ok: true, data: {} }), batch: async () => ({ ok: true, data: {} }) };
  const tcw = { did: "did:example:account", spaceId: "space-1", address: () => "0x00000000000000000000000000000000000000a1", sql: { db: () => emptyDb } } as unknown as TinyCloudWeb;
  const sessionStore = { getToken: () => "signed-in-token" } as unknown as SessionStore;
  const noop = () => {};
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
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
  // Let the cards' effects (the audio cache check, the memory load) run to their end.
  for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  try {
    const cards = [...host.querySelectorAll("section > div > h2")].map((heading) => heading.textContent);
    expect(cards).toEqual(HOME ? HOME_CARDS : PLAIN_CARDS);
    expect(host.querySelector('[data-testid="canvas-setting-row"]') === null).toBe(HOME);
    if (HOME) {
      // The Home site registers no capture engine: Settings must not ask for one, and must not show its failure.
      expect(installCalls).toBe(0);
      expect([...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual([]);
      expect(host.textContent).not.toContain("not implemented");
    }
  } finally {
    await act(async () => root.unmount());
  }
});
