import { EarlierVersionNotes } from "@/capture/local/EarlierVersionNotes";
import { PendingVoiceNoteSignOutDialog } from "@/chat/PendingVoiceNoteSignOutDialog";
import type { VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { DeviceCaptureSurface } from "@/capture/DeviceCaptureSurface";
import { screenFor } from "@/shell/routes";
import type { HarnessScreen } from "../screen";

export const localScreens: HarnessScreen[] = [
  {
    id: "local-signed-out",
    group: "local",
    layout: "pane",
    platform: "android",
    readyWhen: "[data-testid='capture-surface']",
    render: () => <div className="h-dvh overflow-y-auto bg-background">
      <StaticRecorderProvider value={{ signedIn: false }}><DeviceCaptureSurface did={null} offline={false} error={null} onSignIn={() => {}} onRetry={() => {}} screen={screenFor("/chat/capture")} /></StaticRecorderProvider>
    </div>,
  },
  {
    id: "local-offline",
    group: "local",
    layout: "pane",
    platform: "android",
    readyWhen: "[data-testid='capture-surface']",
    render: () => <div className="h-dvh overflow-y-auto bg-background">
      <StaticRecorderProvider value={{ signedIn: false }}><DeviceCaptureSurface did={null} offline error={null} onSignIn={() => {}} onRetry={() => {}} screen={screenFor("/chat/capture")} /></StaticRecorderProvider>
    </div>,
  },
];

// TC-2785: copy and viewport review of the account choice surfaces.
export const accountDataScreens: HarnessScreen[] = [
  {
    id: "local-unowned-notes", group: "local", layout: "document", platform: "web",
    render: () => <div className="min-h-dvh bg-background p-4 text-foreground">
      <EarlierVersionNotes signedOutNotes did="did:harness" notes={[
        { id: "unowned-1", owner: null, startedAt: Date.parse("2026-11-11T09:00:00Z") },
        { id: "unowned-2", owner: null, startedAt: Date.parse("2026-11-11T09:30:00Z") },
      ] as VoiceNoteRecording[]} onChange={async () => {}} onDelete={async () => {}} />
    </div>,
  },
  {
    id: "local-signout-keep", group: "local", layout: "pane", platform: "web",
    readyWhen: "[data-testid='pending-voice-note-signout']",
    render: () => <PendingVoiceNoteSignOutDialog open count={2} error={null} busy={false}
      onKeep={() => {}} onDelete={() => {}} onCancel={() => {}} />,
  },
];
