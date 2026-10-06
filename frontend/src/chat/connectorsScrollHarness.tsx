// Browser harness for test/connectors-scroll.e2e.test.ts: the REAL ConnectorsPage
// (Sources tab) or, at /chat/settings, the REAL SettingsPage, inside the chat
// shell's layout (fixed-height column, header, sidebar grid). Every backend call the cards make fails (the harness server
// answers 401 and the tcw stub rejects), which leaves each card in its
// signed-in-but-empty state: the Transcriber shows its Meeting bot / Upload
// audio tabs and the meeting-link form with its `sr-only` labels.
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { ConnectorsPage } from "./ConnectorsPage";
import { SettingsPage } from "./SettingsPage";
import { AgentAccessProvider } from "./useAgentEnablement";

const rejecting = (): Promise<never> => Promise.reject(new Error("harness: no TinyCloud"));
// Any SDK member resolves to a callable that rejects, at any depth.
const sdkStub = (): unknown =>
  new Proxy(rejecting, { get: (_target, key) => (key === "then" ? undefined : sdkStub()), apply: () => rejecting() });
const tcw = new Proxy(
  { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1", address: () => "0x00000000000000000000000000000000000000a1" },
  { get: (target, key) => (key in target ? target[key as keyof typeof target] : key === "then" ? undefined : sdkStub()) },
) as unknown as TinyCloudWeb;
const sessionStore = { getToken: () => "harness-token", isExpired: () => false, clear: () => {} } as unknown as SessionStore;

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AgentAccessProvider
      tcw={tcw}
      sessionStore={sessionStore}
      backendUrl={window.location.origin}
      appName="harness"
      openkeyHost={window.location.origin}
    >
    <div className="flex flex-col bg-background text-foreground" style={{ height: "100dvh" }}>
      <header data-testid="shell-header" className="border-b border-border px-3 py-2.5 text-sm">Exo</header>
      <main className="min-h-0 flex-1">
        <div className="grid h-full grid-cols-1 md:grid-cols-[260px_1fr]">
          <aside data-testid="shell-sidebar" className="hidden min-h-0 border-r border-border bg-muted/40 md:block" />
          <section className="min-h-0">
            {window.location.pathname.startsWith("/chat/settings") ? (
              <SettingsPage
                address="0x00000000000000000000000000000000000000a1"
                did="did:pkh:eip155:1:0x00000000000000000000000000000000000000a1"
                spaceId="harness-space"
                state="ready"
                error={null}
                onSignOut={() => {}}
                signingOut={false}
                paywallEnabled={false}
                onBack={() => {}}
                tcw={tcw}
                memoryRef={{ current: null }}
                onMemoryUpdated={() => {}}
                onImported={() => {}}
                billingStatus={null}
                billingTierName={null}
                onManagePlan={() => {}}
                onOpenRates={() => {}}
                backendUrl={window.location.origin}
                sessionStore={sessionStore}
              />
            ) : (
              <ConnectorsPage tcw={tcw} backendUrl={window.location.origin} sessionStore={sessionStore} tab="sources" />
            )}
          </section>
        </div>
      </main>
    </div>
    </AgentAccessProvider>
  </BrowserRouter>,
);
