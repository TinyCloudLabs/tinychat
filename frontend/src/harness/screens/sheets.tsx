// The Upload and Meeting sheets (TC-761), open over Capture as a tap leaves
// them: a bottom sheet on a phone, upright or on its side, and a dialog from
// medium up. The bodies are the real views on fixtures, in each state; Capture
// behind them is the real shell on the empty-space stub (harness/ShellApp.tsx).
import { useContext, useMemo } from "react";

import { AudioUploadView, type AudioUploadViewProps } from "@/chat/AudioUploadPanel";
import { SendNotetakerButton, TranscriberView, type TranscriberViewProps } from "@/chat/TranscriberSection";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import type { UploadState } from "@/lib/audioUpload";
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

const job = (patch: Partial<UploadState>): UploadState => ({
  engine: "private-cloud",
  fileName: "Weekly sync.m4a",
  stage: "uploading",
  uploadPct: 42,
  detail: null,
  audio: { stage: "storing", pct: 18 },
  error: null,
  savedTitle: null,
  cleanupPending: false,
  ...patch,
});

function UploadSheetScreen(props: Partial<AudioUploadViewProps>) {
  return (
    <>
      <Capture />
      <ResponsiveSheet open onOpenChange={noop} title="Upload audio" contentProps={{ "data-testid": "upload-sheet" }}>
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
          onOpenLibrary={noop}
          onContinue={noop}
          layout="sheet"
          {...props}
        />
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

function MeetingSheetScreen(props: Partial<TranscriberViewProps>) {
  const view: TranscriberViewProps = {
    listStatus: "ready",
    meetings: MEETINGS,
    saved: { mtg_done: "saved" },
    form: { url: "https://meet.google.com/xyz-abcd-efg", botName: "", submitting: false, error: null },
    busyId: null,
    open: null,
    onUrlChange: noop,
    onBotNameChange: noop,
    onSubmit: noop,
    onRefresh: noop,
    onStop: noop,
    onToggleTranscript: noop,
    onRemove: noop,
    ...props,
  };
  return (
    <>
      <Capture />
      <ResponsiveSheet
        open
        onOpenChange={noop}
        title="Send a notetaker"
        contentProps={{ "data-testid": "meeting-sheet" }}
        footer={<SendNotetakerButton form={view.form} listStatus={view.listStatus} />}
      >
        <ResponsiveSheetBody className="pb-5">
          <TranscriberView {...view} sendInline={false} />
        </ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}

const SHEETS = { group: "sheets", layout: "pane", displayTitle: true, path: "/chat/capture", platform: "ios" } as const;
const UPLOAD = { ...SHEETS, readyWhen: '[data-testid="upload-sheet"]' } as const;
const MEETING = { ...SHEETS, readyWhen: '[data-testid="meeting-sheet"]' } as const;

export const sheetsScreens: HarnessScreen[] = [
  { ...UPLOAD, id: "sheets-upload", render: () => <UploadSheetScreen /> },
  { ...UPLOAD, id: "sheets-upload-uploading", render: () => <UploadSheetScreen job={job({})} /> },
  { ...UPLOAD, id: "sheets-upload-paused", render: () => <UploadSheetScreen paused={{ fileName: "Interview.m4a" }} /> },
  {
    ...UPLOAD,
    id: "sheets-upload-failed",
    render: () => (
      <UploadSheetScreen
        job={job({
          stage: "failed",
          audio: { stage: "stored", pct: 100 },
          error: { message: "Private transcription stopped responding. Your file is safe; try again.", reference: "ptx-7f3a", retry: true },
        })}
      />
    ),
  },
  {
    ...UPLOAD,
    id: "sheets-upload-landed",
    render: () => <UploadSheetScreen job={job({ stage: "saved", savedTitle: "Weekly sync", audio: { stage: "stored", pct: 100 } })} />,
  },
  { ...MEETING, id: "sheets-meeting", render: () => <MeetingSheetScreen /> },
  {
    ...MEETING,
    id: "sheets-meeting-form",
    render: () => <MeetingSheetScreen meetings={[]} form={{ url: "", botName: "", submitting: false, error: null }} />,
  },
];
