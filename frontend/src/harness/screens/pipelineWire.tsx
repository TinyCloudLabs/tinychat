// The saved-note sheet and the recorder's receipt with a note's pipeline in each state (screenshot gallery).
// The pipelines are the selector's own output for each case (capture/pipeline/pipelineFixtures.ts); nothing is
// read from a store, so the cases do not depend on a device or a space.
import type { ReactNode } from "react";

import { NotePipelineContext } from "@/capture/pipeline/NotePipelineContext";
import { PipelineStepper } from "@/capture/pipeline/PipelineStepper";
import { allDone, signedOut, uploading, waitingForModel } from "@/capture/pipeline/pipelineFixtures";
import { Transcript } from "@/capture/library/NoteDetailView";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import { SavedNoteSheet } from "@/capture/library/savedNote/SavedNoteView";
import { savedNoteMeta } from "@/capture/library/savedNote/savedNoteMeta";
import type { SavedNoteStore } from "@/capture/library/savedNote/savedNoteStore";
import { useSavedNoteScreen } from "@/capture/library/savedNote/useSavedNoteScreen";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { SavedReceipt } from "@/capture/recorder/SavedReceipt";
import { voiceNoteRoute } from "@/capture/recorder/RouteLine";
import { useResolvedTheme } from "@/lib/theme";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { FROZEN_NOW } from "../stubs";
import type { HarnessScreen } from "../screen";

const noop = () => {};
const NOTE_ID = "rec-1";
const ITEM: LibraryItem = {
  id: `on-phone:${NOTE_ID}`,
  source: "exo-voice-note",
  sourceId: NOTE_ID,
  title: "Standup",
  startedAt: new Date(FROZEN_NOW - 42_000).toISOString(),
  durationSecs: 42,
  onPhone: true,
};
const STORE: SavedNoteStore = {
  load: async () => ({ md: "- **0:08** Book the venue before Friday", savedEditAt: null }),
  save: async (_id, md) => ({ record: { md, savedEditAt: null }, synced: Promise.resolve() }),
};

const viewOf = (pipeline: NotePipeline, actionError: string | null = null): NotePipelineView => ({ pipeline, onAction: noop, actionError });

function Sheet(props: { pipeline: NotePipeline; actionError?: string }) {
  const screen = useSavedNoteScreen(NOTE_ID, STORE);
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  const view = viewOf(props.pipeline, props.actionError ?? null);
  const showing = !props.pipeline.done;
  return (
    <StaticRecorderProvider value={{}}>
      <NotePipelineContext.Provider value={view}>
        <SavedNoteSheet
          screen={screen}
          layout="sheet"
          theme={theme}
          id={ITEM.id}
          recordingId={NOTE_ID}
          title="Standup"
          meta={savedNoteMeta(ITEM, null, "ios", !showing)}
          stepper={showing ? <PipelineStepper pipeline={view.pipeline} onAction={view.onAction} actionError={view.actionError} /> : null}
          audio={null}
          transcript={
            <Transcript
              item={ITEM}
              listStatus="ready"
              metadata={{ status: "ok", metadata: {} }}
              transcript={{ status: "absent" }}
              audio={null}
              copyState="idle"
              onCopy={noop}
              onRetry={noop}
              pushed
              onBack={noop}
            />
          }
          partialAudio={false}
          onBack={noop}
        />
      </NotePipelineContext.Provider>
    </StaticRecorderProvider>
  );
}

function Receipt(props: { pipeline: NotePipeline; outcome: "local" | "saved"; actionError?: string }) {
  return (
    <StaticRecorderProvider value={{}}>
      <div className="min-h-full bg-background p-3 pt-[max(env(safe-area-inset-top),1rem)]">
        <SavedReceipt
          outcome={props.outcome}
          saved={{ id: NOTE_ID, durationMs: 42_000, at: FROZEN_NOW - 42_000 }}
          route={voiceNoteRoute("private-cloud")}
          transcriber="private-cloud"
          pipeline={viewOf(props.pipeline, props.actionError ?? null)}
          onDone={noop}
          onSaveNow={noop}
        />
      </div>
    </StaticRecorderProvider>
  );
}

const screen = (id: string, readyWhen: string, render: () => ReactNode, layout: HarnessScreen["layout"] = "pane"): HarnessScreen => ({
  id: `pipeline-wire-${id}`,
  group: "pipelineWire",
  layout,
  platform: "ios",
  displayTitle: false,
  readyWhen,
  render,
});

const SHEET_READY = '[data-testid="saved-note-sheet"] [data-testid="note-transcript-pipeline"], [data-testid="saved-note-sheet"] [data-testid="note-transcript-on-phone"], [data-testid="saved-note-sheet"] [data-pipeline-stepper]';
const RECEIPT_READY = '[data-testid="voice-note-receipt"]';

export const pipelineWireScreens: HarnessScreen[] = [
  screen("sheet-uploading", SHEET_READY, () => <Sheet pipeline={uploading(42)} />),
  screen("sheet-signed-out", SHEET_READY, () => <Sheet pipeline={signedOut()} />),
  screen("sheet-signed-out-action-failed", SHEET_READY, () => <Sheet pipeline={signedOut()} actionError="Sign-in could not start: no connection." />),
  screen("sheet-waiting-for-model", SHEET_READY, () => <Sheet pipeline={waitingForModel()} />),
  screen("sheet-done", '[data-testid="saved-note-sheet"]', () => <Sheet pipeline={allDone()} />),
  screen("receipt-uploading", RECEIPT_READY, () => <Receipt outcome="local" pipeline={uploading(42)} />, "document"),
  screen("receipt-signed-out", RECEIPT_READY, () => <Receipt outcome="local" pipeline={signedOut()} />, "document"),
  screen("receipt-signed-out-action-failed", RECEIPT_READY, () => <Receipt outcome="local" pipeline={signedOut()} actionError="Sign-in could not start: no connection." />, "document"),
  screen("receipt-waiting-for-model", RECEIPT_READY, () => <Receipt outcome="saved" pipeline={waitingForModel()} />, "document"),
  screen("receipt-done", RECEIPT_READY, () => <Receipt outcome="saved" pipeline={allDone()} />, "document"),
];
