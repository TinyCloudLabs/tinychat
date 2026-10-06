// The Upload and Meeting sheets (TC-761), open over Capture as a tap leaves
// them: a bottom sheet on a phone, upright or on its side, and a dialog from
// medium up. The bodies are the real views on fixtures; Capture behind them is
// the real shell on the empty-space stub (harness/ShellApp.tsx).
import { useContext, useMemo } from "react";

import { AudioUploadView } from "@/chat/AudioUploadPanel";
import { TranscriberView } from "@/chat/TranscriberSection";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { PlatformContext } from "@/lib/platform";
import type { TranscriberMeeting } from "@/lib/transcriberApi";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";

const noop = () => {};

function Capture() {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  return <ShellApp platform={platform} shim={shim} state="ready" />;
}

function UploadSheetScreen() {
  return (
    <>
      <Capture />
      <ResponsiveSheet open onOpenChange={noop} title="Upload audio" contentProps={{ "data-testid": "upload-sheet" }}>
        <ResponsiveSheetBody className="pb-5">
          <AudioUploadView
            job={null}
            file={{ name: "Weekly sync.m4a", type: "audio/mp4", size: 24_300_000 }}
            engine="private-cloud"
            engines={{ "private-cloud": { state: "available" }, assemblyai: { state: "available" } }}
            assemblyAiMode="hosted"
            diarize
            diarizeUnavailable="Speaker identification isn't available for private transcription yet."
            fileProblem={null}
            onEngineChange={noop}
            onDiarizeChange={noop}
            onFile={noop}
            onTranscribe={noop}
            onRetry={noop}
            onDismiss={noop}
            onOpenSettings={noop}
            onRecheck={noop}
          />
        </ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}

const MEETINGS: TranscriberMeeting[] = [
  {
    id: "mtg_live",
    status: "in_progress",
    platform: "google_meet",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    bot: { name: "TinyCloud Private Notetaker" },
    created_at: "2026-10-06T09:30:00.000Z",
  },
  {
    id: "mtg_done",
    status: "completed",
    platform: "google_meet",
    meeting_url: "https://meet.google.com/kpq-wxyz-rst",
    bot: { name: "TinyCloud Private Notetaker" },
    created_at: "2026-10-05T14:00:00.000Z",
    capture: { completion_reason: "stopped" },
  },
];

function MeetingSheetScreen() {
  return (
    <>
      <Capture />
      <ResponsiveSheet open onOpenChange={noop} title="Send a notetaker" contentProps={{ "data-testid": "meeting-sheet" }}>
        <ResponsiveSheetBody className="pb-5">
          <TranscriberView
            listStatus="ready"
            meetings={MEETINGS}
            saved={{ mtg_done: "saved" }}
            form={{ url: "https://meet.google.com/xyz-abcd-efg", botName: "", submitting: false, error: null }}
            busyId={null}
            open={null}
            onUrlChange={noop}
            onBotNameChange={noop}
            onSubmit={noop}
            onRefresh={noop}
            onStop={noop}
            onToggleTranscript={noop}
            onRemove={noop}
          />
        </ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}

const SHEETS = { group: "sheets", layout: "pane", displayTitle: true, path: "/chat/capture", platform: "ios" } as const;

export const sheetsScreens: HarnessScreen[] = [
  { ...SHEETS, id: "sheets-upload", readyWhen: '[data-testid="upload-sheet"]', render: () => <UploadSheetScreen /> },
  { ...SHEETS, id: "sheets-meeting", readyWhen: '[data-testid="meeting-sheet"]', render: () => <MeetingSheetScreen /> },
];
