import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ConnectorsCard } from "./ConnectorsCard";
import { ConnectorsTabs, type ConnectorsTab } from "./connectorsNav";
import { LibraryPage } from "./LibraryPage";
import { TranscriberSection } from "./TranscriberSection";

interface ConnectorsPageProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** Which peer tab is open — derived from the route by App. */
  tab: ConnectorsTab;
  /**
   * The cohort meeting archive is owned by App because App owns the signed-in
   * session. It stays optional: outside the backend-ingest cohort the section
   * returns null and leaves no empty placeholder behind. Passed through to
   * Library, where every browsable meeting now lives.
   */
  meetingsSlot?: React.ReactNode;
}

/**
 * The persistent Connectors workspace: one page, two peer tabs.
 *
 *   Sources — set connectors up and capture from them (the connector rows and
 *             the transcriber).
 *   Library — browse what they have already synced (Meetings today).
 *
 * There is no back affordance here on purpose: this page renders inside the
 * chat workspace, so the persistent sidebar is always on screen (a sheet on
 * mobile) and is the way back to a thread. A second "Back to chat" button would
 * be a redundant, weaker version of navigation the user already has.
 *
 * This deliberately follows TinyChat's existing narrow, card-based page
 * language. Connectors is promoted in the app hierarchy without importing a
 * dashboard shell or a second visual system.
 */
export function ConnectorsPage({
  tcw,
  backendUrl,
  sessionStore,
  tab,
  meetingsSlot,
}: ConnectorsPageProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
        {/* One stable page header across both tabs — the tab strip below is
            what changes, not the identity of the page. */}
        <h1 className="text-base font-semibold tracking-tight">Connectors</h1>
        <p className="mb-4 mt-1 text-sm leading-relaxed text-muted-foreground">
          Bring meeting notes and transcripts into your private space. You
          choose each source, when it syncs, and when its access ends.
        </p>

        <ConnectorsTabs active={tab} />

        {tab === "library" ? (
          <LibraryPage tcw={tcw} meetingsSlot={meetingsSlot} />
        ) : (
          <div className="flex flex-col gap-4">
            <ConnectorsCard
              tcw={tcw}
              backendUrl={backendUrl}
              sessionStore={sessionStore}
              title="Meeting sources"
            />
            <TranscriberSection
              backendUrl={backendUrl}
              sessionStore={sessionStore}
              tcw={tcw}
            />
          </div>
        )}
      </div>
    </div>
  );
}
