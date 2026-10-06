// The surfaces as they are today, re-tokened: the real SettingsPage (with
// Appearance) and ConnectorsPage, in a shell with the chat layout (a header,
// the sidebar from md, a pane that scrolls on its own). They stay until the new
// shell and screens replace them.
import type { ReactNode } from "react";
import { PanelLeftIcon } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { ConnectorsPage } from "@/chat/ConnectorsPage";
import { SettingsPage } from "@/chat/SettingsPage";
import { AgentAccessProvider } from "@/chat/useAgentEnablement";
import { HARNESS_ADDRESS, HARNESS_DID, harnessSessionStore, harnessTcw } from "../stubs";
import type { HarnessScreen } from "../screen";

function LegacyShell(props: { children: ReactNode }) {
  return (
    <AgentAccessProvider
      tcw={harnessTcw}
      sessionStore={harnessSessionStore}
      backendUrl={window.location.origin}
      appName="harness"
      openkeyHost={window.location.origin}
    >
      <div
        className="flex flex-col bg-background text-foreground pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
        style={{ height: "var(--tc-app-height, 100dvh)" }}
      >
        <header className="flex items-center justify-between gap-1.5 border-b border-border px-3 py-2.5 sm:gap-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-input md:hidden" aria-hidden>
              <PanelLeftIcon className="size-4" />
            </span>
            <span className="flex shrink-0 items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
                T
              </span>
              <span className="hidden sm:inline">TinyCloud Chat</span>
            </span>
          </div>
          <span className="hidden sm:inline-flex">
            <ThemeToggle />
          </span>
        </header>
        <main className="min-h-0 flex-1">
          <div className="grid h-full grid-cols-1 md:grid-cols-[260px_1fr]">
            <aside className="hidden min-h-0 border-r border-border bg-muted/40 md:block" />
            <section className="min-h-0">{props.children}</section>
          </div>
        </main>
      </div>
    </AgentAccessProvider>
  );
}

export const legacyScreens: HarnessScreen[] = [
  {
    id: "legacy-settings",
    group: "legacy",
    layout: "pane",
    displayTitle: true,
    path: "/chat/settings",
    // The Appearance card (System · Light · Dark), the part of Settings this redesign adds.
    scrollTo: "section:has(> div > svg.lucide-sun)",
    render: () => (
      <LegacyShell>
        <SettingsPage
          address={HARNESS_ADDRESS}
          did={HARNESS_DID}
          spaceId="harness-space"
          state="ready"
          error={null}
          onSignOut={() => {}}
          signingOut={false}
          paywallEnabled={false}
          onBack={() => {}}
          tcw={harnessTcw}
          memoryRef={{ current: null }}
          onMemoryUpdated={() => {}}
          onImported={() => {}}
          billingStatus={null}
          billingTierName={null}
          onManagePlan={() => {}}
          onOpenRates={() => {}}
          backendUrl={window.location.origin}
          sessionStore={harnessSessionStore}
        />
      </LegacyShell>
    ),
  },
  {
    id: "legacy-connectors",
    group: "legacy",
    layout: "pane",
    displayTitle: true,
    path: "/chat/connectors",
    render: () => (
      <LegacyShell>
        <ConnectorsPage tcw={harnessTcw} backendUrl={window.location.origin} sessionStore={harnessSessionStore} tab="sources" />
      </LegacyShell>
    ),
  },
];
