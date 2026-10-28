// A voice note on this Mac in each transcription state (TC-2167): waiting, transcribing with progress, failed with its action,
// done, and the note's local audio with its player. The real NoteDetailView over a note pipeline.
import { NotePipelineContext } from "@/capture/pipeline/NotePipelineContext";
import { NoteDetailView, type NoteAudio } from "@/capture/library/NoteDetailView";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { HarnessScreen } from "../screen";

const noop = () => {};
const MINUTES = 56;
const item: LibraryItem = { id: "note-tx", source: "exo-voice-note", sourceId: "rec-tx", title: "Voice note · Oct 27 at 5:00 PM", startedAt: "2026-10-27T17:00:00Z", durationSecs: MINUTES * 60 };
const saved = { saved: true, pending: null, lane: { busy: false, depth: 0 } } as const;
const stt = (state: "queued" | "running" | "failed", percent: number | null) => ({ inSpace: null, cloud: null,
  onDevice: { stt: { state, error: state === "failed" ? "decoder_error" : null }, queue: { position: state === "queued" ? 2 : 1, inLine: 2, percent }, model: null, download: "idle" as const, sync: null } });

function pipelineView(transcript: NotePipelineInput["transcript"]): NotePipelineView {
  const input: NotePipelineInput = { device: "mac", route: "on-device", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null }, space: saved, transcript, notes: { state: "idle" } };
  return { input, pipeline: notePipeline(input), provider: "local", onAction: noop, actionError: null };
}

/** A minute of silence, so the player has a real file to load and seek in. */
function silentWav(): Blob {
  const rate = 8000;
  const samples = rate * 60;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}
const AUDIO: NoteAudio = { load: async () => silentWav(), onPhone: true };

function Note(props: { transcript?: NotePipelineInput["transcript"]; done?: boolean; audio?: boolean; localOnly?: boolean }) {
  const view = props.transcript ? pipelineView(props.transcript) : undefined;
  return (
    <>
      <NotePipelineContext.Provider value={view ?? null}>
        <div className="h-full overflow-y-auto bg-background">
          <NoteDetailView item={item} listStatus="ready" platform="tauri" desktopWhisper={false}
            metadata={{ status: "ok", metadata: { capture: { platform: "tauri" }, audio: { stored: props.localOnly ? false : true, base: "b" },
              ...(props.done ? { transcription_outcome: "transcribed" } : {}) } }}
            transcript={props.done ? { status: "ok", sentences: [
              { index: 0, speaker_name: "Me", text: "Let’s start with the roadmap.", start_time: 0, end_time: 4 },
              { index: 1, speaker_name: "Me", text: "Then the budget review.", start_time: 4, end_time: 9 }] } : { status: "absent" }}
            audio={props.audio ? AUDIO : null} activityView={view} copyState="idle" onCopy={noop} onRetry={noop} pushed={false} onBack={noop} />
        </div>
      </NotePipelineContext.Provider>
    </>
  );
}

const VIEWPORTS = ["desktop", "phone"];
const screenOf = (id: string, readyWhen: string, render: () => React.ReactNode): HarnessScreen =>
  ({ id: `transcription-status-${id}`, group: "transcriptionStatus", layout: "pane", displayTitle: true, path: "/chat/capture/library/note-tx", platform: "tauri", viewports: VIEWPORTS, readyWhen, render });

export const transcriptionStatusScreens: HarnessScreen[] = [
  screenOf("waiting", '[data-testid="note-detail"]', () => <Note transcript={stt("queued", null)} />),
  screenOf("transcribing", '[data-testid="note-detail"]', () => <Note transcript={stt("running", 40)} audio localOnly />),
  screenOf("failed", '[data-testid="note-detail"]', () => <Note transcript={stt("failed", null)} />),
  screenOf("done", '[data-testid="note-detail"]', () => <Note done audio localOnly />),
];
