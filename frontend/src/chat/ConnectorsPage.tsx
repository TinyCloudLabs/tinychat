import { lazy, Suspense } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { useNavKind } from "@/shell/navItems";
import { PAGE_COLUMN, PageHeader, SettingsGear } from "@/shell/PageHeader";
import { ConnectorsCard } from "./ConnectorsCard";
import { recorderFinalEnabled } from "@/capture/recorder/final/recorderFinalFlag";

const MeetingSourcesFeature = recorderFinalEnabled()
  ? lazy(() => import("@/capture/meetingSources/MeetingSourcesDialog").then((m) => ({ default: m.MeetingSourcesFeature })))
  : null;

// Health spike (TC-525): development-only, and only in builds with VITE_EXO_HEALTH_SPIKE=true (the rule of
// healthSpikeEnabled, written out so Vite can inline it: a normal build drops the card's chunk entirely).
const HealthSpikeSection = import.meta.env.VITE_EXO_HEALTH_SPIKE === "true"
  ? lazy(() => import("./HealthSpikeSection").then((m) => ({ default: m.HealthSpikeSection })))
  : null;
// TC-524 location spike: a developer card, in the bundle only when the build sets VITE_EXO_LOCATION_SPIKE=true.
// Vite inlines the flag, so in every other build this is `null` and the chunk is never emitted.
const LocationSpikeSection =
  import.meta.env.VITE_EXO_LOCATION_SPIKE === "true" ? lazy(() => import("./LocationSpikeSection")) : null;

interface ConnectorsPageProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
}

/**
 * Connectors (TC-761): the meeting sources a user connects and syncs, one page
 * and one of the app's three destinations. Capture (recording, uploads, the
 * notetaker) and the Library moved to Capture, so this is the connector rows
 * and, in builds that ask for them, the development spikes.
 *
 * There is no back affordance: it is a destination, and the shell's navigation
 * is always on screen.
 */
export function ConnectorsPage({ tcw, backendUrl, sessionStore }: ConnectorsPageProps) {
  const nav = useNavKind();
  const meetingSourcesEnabled = MeetingSourcesFeature !== null && nav !== "tabbar";
  return (
    // `relative` makes this scroller the containing block for absolutely
    // positioned descendants (the `sr-only` form labels). Without it they
    // resolve against the initial containing block, escape the scroller and
    // stretch the document, so the whole app shell scrolls.
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title="Connectors" trailing={nav === "tabbar" ? <SettingsGear /> : undefined} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        {/* One line; what each source can reach, autojoin and background
            notifications are How it works → Connectors. */}
        <div className="mb-4 mt-1 flex flex-wrap items-center gap-x-3">
          <p className="text-callout text-muted-foreground">Bring meeting notes into your private space.</p>
          <HowItWorksLink section="connectors" />
        </div>
        <div className="flex flex-col gap-4">
          {HealthSpikeSection && (
            <Suspense fallback={null}>
              <HealthSpikeSection tcw={tcw} />
            </Suspense>
          )}
          {LocationSpikeSection && (
            <Suspense fallback={null}>
              <LocationSpikeSection tcw={tcw} />
            </Suspense>
          )}
          {meetingSourcesEnabled ? (
            <Suspense fallback={null}>
              <MeetingSourcesFeature tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} />
            </Suspense>
          ) : (
            <ConnectorsCard tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} title="Meeting sources" />
          )}
        </div>
      </div>
    </div>
  );
}
