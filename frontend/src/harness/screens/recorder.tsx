// The recorder's receipt and minimised presentations over a StaticRecorderProvider on the frozen
// clock: the receipt dialog, the island, and the rail and sidebar live controls. The page under the
// island, the rail and the sidebar are stand-ins. The recording view itself is in recorderFinal*.
import type { ReactNode } from "react";
import { SettingsIcon } from "lucide-react";

import { Island } from "@/capture/recorder/Island";
import { RailLiveButton } from "@/capture/recorder/RailLiveButton";
import { RecordingOverlay } from "@/capture/recorder/RecordingOverlay";
import { StaticRecorderProvider, type RecorderValue } from "@/capture/recorder/RecorderProvider";
import { SidebarLiveCard } from "@/capture/recorder/SidebarLiveCard";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { FROZEN_NOW } from "../stubs";
import type { HarnessScreen } from "../screen";

const noop = () => {};

/** Seeded input levels: speech-like, the same on every run. */
const LEVELS = Array.from({ length: 96 }, (_, i) =>
  Math.min(1, Math.max(0, 0.32 + 0.24 * Math.sin(i * 0.61) + 0.18 * Math.sin(i * 1.73 + 1.1) + 0.08 * Math.cos(i * 3.1))),
);

const PRIVATE_CLOUD_ON: VoiceNoteTranscriptionProps = {
  availability: "available",
  consented: true,
  maxSeconds: 600,
  jobs: new Map(),
  onTranscribe: noop,
  onConsent: noop,
  onTurnOff: noop,
  onRecheck: noop,
};

const minutes = (m: number, s = 0) => (m * 60 + s) * 1000;

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: FROZEN_NOW - minutes(12, 48),
  audioMs: minutes(12, 48),
  transcription: PRIVATE_CLOUD_ON,
};

function Backdrop(props: { children?: ReactNode }) {
  return <div className="h-full bg-background">{props.children}</div>;
}

function sheet(id: string, value: Partial<RecorderValue>): HarnessScreen {
  return {
    id: `recorder-${id}`,
    group: "recorder",
    layout: "pane",
    platform: "ios",
    displayTitle: false,
    render: () => (
      <StaticRecorderProvider value={{ ...value, sheetOpen: true }} levels={LEVELS}>
        <Backdrop />
        <RecordingOverlay onOpenNote={noop} />
      </StaticRecorderProvider>
    ),
  };
}

function island(id: string, value: Partial<RecorderValue>): HarnessScreen {
  return {
    id: `recorder-island-${id}`,
    group: "recorder",
    layout: "pane",
    platform: "ios",
    displayTitle: true,
    render: () => (
      <StaticRecorderProvider value={{ ...value, sheetOpen: false }} levels={LEVELS}>
        <div className="flex h-full flex-col bg-background pt-[env(safe-area-inset-top)]">
          <main className="min-h-0 flex-1">
            <PageStandIn />
          </main>
          <div className="shrink-0 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
            <Island onOpenNote={noop} />
          </div>
        </div>
      </StaticRecorderProvider>
    ),
  };
}

/** A page under the island, standing in for Chat and Connectors until the new shell (PR3) has the island row. */
function PageStandIn() {
  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <h1 className="font-display text-title-1">Connectors</h1>
      <ul className="mt-4 flex flex-col divide-y divide-border">
        {["Google Calendar", "Fireflies", "Notion", "GitHub"].map((name) => (
          <li key={name} className="flex min-h-14 items-center text-body">
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Stand-ins for the new shell's rail and sidebar (PR3), holding the live controls. */
function NavStandIn(props: { kind: "rail" | "sidebar" }) {
  return (
    <StaticRecorderProvider value={{ ...LIVE, sheetOpen: false }} levels={LEVELS}>
      <div className="flex h-full bg-background">
        <nav
          aria-label="Stand-in navigation"
          className={
            props.kind === "rail"
              ? "flex w-[calc(4.5rem+env(safe-area-inset-left))] shrink-0 flex-col items-center justify-end gap-2 border-r border-border bg-chrome pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)]"
              : "flex w-60 shrink-0 flex-col justify-end gap-2 border-r border-border bg-chrome p-3"
          }
        >
          {props.kind === "rail" ? <RailLiveButton /> : <SidebarLiveCard />}
          <span className="flex h-11 items-center gap-2 px-3 text-muted-foreground" aria-hidden="true">
            <SettingsIcon className="size-5" />
            {props.kind === "sidebar" && <span className="text-callout">Settings</span>}
          </span>
        </nav>
        <main className="min-w-0 flex-1 p-6">
          <h1 className="font-display text-title-1">Capture</h1>
        </main>
      </div>
    </StaticRecorderProvider>
  );
}

const SAVED = { id: "rec-1", durationMs: 42_000, at: FROZEN_NOW };

export const recorderScreens: HarnessScreen[] = [
  sheet("landed", { phase: "idle", outcome: "saved", lastSaved: SAVED, transcription: PRIVATE_CLOUD_ON }),
  sheet(
    "landed-partial",
    { phase: "idle", outcome: "saved", lastSaved: SAVED, transcription: PRIVATE_CLOUD_ON, captureIssues: { "rec-1": { kind: "partial_audio", missingMs: 12_000 } } },
  ),
  sheet("local", { phase: "idle", outcome: "local", localUpload: "uploading", lastSaved: SAVED, transcription: PRIVATE_CLOUD_ON }),
  sheet("failed", {
    phase: "idle",
    outcome: "failed",
    error: "Recorded, but saving to your space failed: The network connection was lost.",
    pending: { listing: { state: "ok", count: 1 }, running: false, lastError: null },
  }),
  island("live", LIVE),
  island("saving", { ...LIVE, phase: "saving", savePercent: 42 }),
  island("landed", { phase: "idle", outcome: "saved", lastSaved: SAVED }),
  island("failed", { phase: "idle", outcome: "failed", pending: { listing: { state: "ok", count: 1 }, running: false, lastError: null } }),
  { id: "recorder-rail-live", group: "recorder", layout: "pane", displayTitle: true, render: () => <NavStandIn kind="rail" /> },
  { id: "recorder-sidebar-live", group: "recorder", layout: "pane", displayTitle: true, render: () => <NavStandIn kind="sidebar" /> },
];
