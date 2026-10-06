// The voice-note recorder (TC-761, PR4) in each of its states, over a
// StaticRecorderProvider on the frozen clock: the sheet (or the dialog on wide
// screens), the island, and the rail and sidebar live controls. Until the new
// shell (PR3) lands, the page under the island, the rail and the sidebar are
// stand-ins.
import { useEffect, type ReactNode } from "react";
import { SettingsIcon } from "lucide-react";

import { Island } from "@/capture/recorder/Island";
import { liveCapture } from "@/capture/recorder/liveCapture";
import { LiveEdge } from "@/capture/recorder/LiveEdge";
import { RailLiveButton } from "@/capture/recorder/RailLiveButton";
import { RecorderSheet } from "@/capture/recorder/RecorderSheet";
import { StaticRecorderProvider, type RecorderValue } from "@/capture/recorder/RecorderProvider";
import { SidebarLiveCard } from "@/capture/recorder/SidebarLiveCard";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { FROZEN_NOW } from "../stubs";
import type { HarnessScreen } from "../screen";

const noop = () => {};

/** Seeded input levels: speech-like, the same on every run. */
const LEVELS = Array.from({ length: 48 }, (_, i) =>
  Math.min(1, Math.max(0, 0.32 + 0.24 * Math.sin(i * 0.61) + 0.18 * Math.sin(i * 1.73 + 1.1) + 0.08 * Math.cos(i * 3.1))),
);
const QUIET = LEVELS.map(() => 0);

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
  transcription: PRIVATE_CLOUD_ON,
};

/** Publishes the live microphone for the Live Edge, as the real provider does. */
function LiveMic(props: { warning?: boolean }) {
  useEffect(() => {
    liveCapture.set({ source: "voice-note", warning: props.warning ?? false, startedAt: LIVE.startedAt ?? null });
    liveCapture.setLevel(0.5);
    return () => liveCapture.set(null);
  }, [props.warning]);
  return <LiveEdge />;
}

function Backdrop(props: { children?: ReactNode }) {
  return <div className="h-full bg-background">{props.children}</div>;
}

function sheet(
  id: string,
  value: Partial<RecorderValue>,
  options: { levels?: readonly number[]; live?: boolean; warning?: boolean; consentAsking?: boolean; discardAsking?: boolean } = {},
): HarnessScreen {
  return {
    id: `recorder-${id}`,
    group: "recorder",
    layout: "pane",
    // The timer is the display face; a failed save shows none.
    displayTitle: value.outcome !== "failed",
    render: () => (
      <StaticRecorderProvider value={{ ...value, sheetOpen: true }} levels={options.levels ?? LEVELS}>
        <Backdrop />
        <RecorderSheet onOpenNote={noop} consentAsking={options.consentAsking} discardAsking={options.discardAsking} />
        {options.live && <LiveMic warning={options.warning} />}
      </StaticRecorderProvider>
    ),
  };
}

function island(id: string, value: Partial<RecorderValue>, live = false): HarnessScreen {
  return {
    id: `recorder-island-${id}`,
    group: "recorder",
    layout: "pane",
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
        {live && <LiveMic />}
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
      <LiveMic />
    </StaticRecorderProvider>
  );
}

const SAVED = { id: "rec-1", durationMs: 42_000, at: FROZEN_NOW };

export const recorderScreens: HarnessScreen[] = [
  sheet("starting", { phase: "starting", startedAt: null, transcription: PRIVATE_CLOUD_ON }, { levels: QUIET }),
  sheet("live", LIVE, { live: true }),
  sheet("silenced", { ...LIVE, mic: { state: "silenced", reason: "os_silenced" } }, { levels: QUIET, live: true, warning: true }),
  sheet("no-signal", { ...LIVE, mic: { state: "recording", reason: "no_signal" } }, { levels: QUIET, live: true, warning: true }),
  sheet("near-limit", { ...LIVE, startedAt: FROZEN_NOW - minutes(56, 12) }, { live: true }),
  sheet("saving", { ...LIVE, phase: "saving", savePercent: 42 }),
  sheet("landed", { phase: "idle", outcome: "saved", lastSaved: SAVED, transcription: PRIVATE_CLOUD_ON }),
  sheet("failed", {
    phase: "idle",
    outcome: "failed",
    error: "Recorded, but saving to your space failed: The network connection was lost.",
    pending: { listing: { state: "ok", count: 1 }, running: false, lastError: null },
  }),
  sheet("consent", { ...LIVE, transcription: { ...PRIVATE_CLOUD_ON, consented: false } }, { live: true, consentAsking: true }),
  // Discard's question, in place of the header's action (PR5).
  sheet("discard", LIVE, { live: true, discardAsking: true }),
  island("live", LIVE, true),
  island("saving", { ...LIVE, phase: "saving", savePercent: 42 }),
  island("landed", { phase: "idle", outcome: "saved", lastSaved: SAVED }),
  island("failed", { phase: "idle", outcome: "failed", pending: { listing: { state: "ok", count: 1 }, running: false, lastError: null } }),
  { id: "recorder-rail-live", group: "recorder", layout: "pane", displayTitle: true, render: () => <NavStandIn kind="rail" /> },
  { id: "recorder-sidebar-live", group: "recorder", layout: "pane", displayTitle: true, render: () => <NavStandIn kind="sidebar" /> },
];
