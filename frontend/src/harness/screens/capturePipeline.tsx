import { SoftCaptureHome } from "@/capture/home/SoftCaptureHome";
import { SoftHomeProvider } from "@/capture/home/softHome";
import { useSoftTheme } from "@/capture/home/softTheme";
import type { InProgressRowsViewProps } from "@/capture/InProgressRows";
import { LibraryListView } from "@/capture/library/LibraryListView";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import type { HarnessScreen } from "../screen";

const noop = () => undefined;
const NOW = new Date(2026, 9, 6, 9, 41);
const items: LibraryItem[] = [
  { id: "on-phone:rec-uploading", source: "exo-voice-note", sourceId: "rec-uploading", title: null, startedAt: new Date(2026, 9, 6, 9, 38).toISOString(), durationSecs: 185, onPhone: true },
  { id: "on-phone:rec-model", source: "exo-voice-note", sourceId: "rec-model", title: null, startedAt: new Date(2026, 9, 6, 9, 32).toISOString(), durationSecs: 71, onPhone: true },
  { id: "row-signed-out", source: "exo-voice-note", sourceId: "rec-signed-out", title: "Call the venue", startedAt: new Date(2026, 9, 5, 15, 12).toISOString(), durationSecs: 42 },
];
const pipeline = (patch: Partial<NotePipeline> = {}): NotePipeline => ({
  steps: [
    { key: "phone", label: "On this phone", state: "done" },
    { key: "space", label: "In your space", state: "active", caption: "Uploading · 42%", progress: 0.42 },
  { key: "transcript", label: "Transcript", state: "done", sublabel: "Ready on this phone" },
    { key: "notes", label: "Notes", state: "skipped" },
  ], current: "space", done: false, ...patch,
});
const model = pipeline({ steps: [
  { key: "phone", label: "On this phone", state: "done" },
  { key: "space", label: "In your space", state: "done" },
  { key: "transcript", label: "Transcript", state: "active", caption: "Waiting for the on-device model · 42%", progress: 0.42 },
  { key: "notes", label: "Notes", state: "skipped" },
], current: "transcript" });
const signedOut = pipeline({ steps: [
  { key: "phone", label: "On this phone", state: "done" },
  { key: "space", label: "In your space", state: "blocked", blocker: { cause: "You're signed out. This note is safe on this phone.", action: { kind: "sign-in", label: "Sign in" } } },
  { key: "transcript", label: "Transcript", state: "upcoming" },
  { key: "notes", label: "Notes", state: "skipped" },
], current: "space", blocker: { cause: "You're signed out. This note is safe on this phone.", action: { kind: "sign-in", label: "Sign in" } } });
const pipelines = new Map<string, NotePipeline>([
  ["rec-uploading", pipeline()],
  ["rec-model", model],
  ["rec-signed-out", signedOut],
]);
const idle: InProgressRowsViewProps = {
  upload: null, paused: null, meetings: [], busyId: null,
  voice: { listing: { state: "ok", count: 2 }, saving: false, lastError: null, limitNotice: null, onSaveNow: noop },
  onOpenUpload: noop, onContinue: noop, onOpenMeeting: noop, onEnd: noop,
};

function SoftFrame(props: { children: React.ReactNode; title: string }) {
  const theme = useSoftTheme();
  return (
    <SoftHomeProvider enabled issues={{}} onDismissIssue={() => true}>
      <main className={`soft-home soft-skin ${theme} h-full overflow-y-auto px-4 pb-6`} data-layout="phone">
        <h1 className="py-4 font-display text-title-1">{props.title}</h1>
        {props.children}
      </main>
    </SoftHomeProvider>
  );
}

export const capturePipelineScreens: HarnessScreen[] = [
  {
    id: "capture-soft-pipeline-card", group: "capturePipeline", layout: "pane", path: "/chat/capture", platform: "ios",
    readyWhen: '[data-testid="voice-note-pending"]',
    render: () => <SoftFrame title="Capture"><div className="flex flex-1 flex-col gap-6 pt-2 pb-4"><SoftCaptureHome
      inProgress={idle}
      recent={{ status: "ready", items }}
      pipelineNotes={items}
      pipelines={pipelines}
      modelProgress={{ bytes: 268_000_000, totalBytes: 640_000_000 }}
      onPipelineAction={noop}
      onOpenRecentNote={noop}
      onOpenLibrary={noop}
      scanFailure={null}
      onRetryRecent={noop}
      now={NOW}
    /></div></SoftFrame>,
  },
  {
    id: "capture-soft-pipeline-library", group: "capturePipeline", layout: "pane", path: "/chat/capture/library", platform: "ios",
    readyWhen: '[data-testid="library-list"][data-state="ready"]',
    render: () => <SoftFrame title="Library"><LibraryListView
      status="ready" items={items} filter="all" onFilterChange={noop} onRetry={noop} now={NOW} pipelines={pipelines}
    /></SoftFrame>,
  },
];
