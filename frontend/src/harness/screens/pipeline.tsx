// Independent audio and transcript tracks in each state, on the Soft skin (screenshot gallery; nothing is wired).
import { PipelineStepper } from "@/capture/pipeline/PipelineStepper";
import { useResolvedTheme } from "@/lib/theme";
import { notePipeline, type NotePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { HarnessScreen } from "../screen";

const IDLE = { busy: false, depth: 0 };
const base: NotePipelineInput = {
  device: "phone",
  route: "private-cloud",
  hasNotesOrMoments: true,
  online: true,
  capture: { finalizing: false, issue: null },
  space: { saved: false, pending: {}, lane: IDLE },
  transcript: { inSpace: null, onDevice: null, cloud: null },
  notes: { state: "idle" },
};
const SAVED = { saved: true, pending: null, lane: IDLE } as const;
const unsaved = (pending: NonNullable<NotePipelineInput["space"]["pending"]>, lane = IDLE) => ({ saved: false, pending, lane });
const onDevice = (patch: Partial<NonNullable<NotePipelineInput["transcript"]["onDevice"]>>) => ({
  stt: null, queue: null, model: null, download: "idle" as const, sync: null, ...patch,
});

const CASES: [string, Partial<NotePipelineInput>][] = [
  ["Waiting, 2nd in line", { space: unsaved({ waitingBehind: 1 }, { busy: true, depth: 2 }) }],
  ["Uploading", { space: unsaved({ upload: { state: "uploading", bytes: 42, total: 100 } }) }],
  ["Signed out", { space: unsaved({ held: "signed-out" }) }],
  ["Offline", { online: false }],
  ["Upload failed", { space: unsaved({ failed: { kind: "timeout", message: "deadline" } }) }],
  ["Audio too large (info only)", { space: unsaved({ failed: { kind: "source", message: "Audio file is too large to read" } }) }],
  ["Private: transcribing 4 of 9", { space: SAVED, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed: 4, total: 9 } } } }],
  ["Private unavailable", { space: SAVED, transcript: { inSpace: null, onDevice: null, cloud: { kind: "blocked", reason: "unavailable" } } }],
  ["Local: downloading the model", { route: "on-device", space: SAVED, transcript: { inSpace: null, cloud: null, onDevice: onDevice({ model: { state: "downloading", bytes: 268, totalBytes: 640, error: null }, download: "running" }) } }],
  ["Transcript ready on this phone, audio waiting 2nd", { route: "on-device", space: unsaved({ waitingBehind: 1 }, { busy: true, depth: 2 }), transcript: { inSpace: null, cloud: null, onDevice: onDevice({ stt: { state: "done", error: null } }) } }],
  ["Transcribing on this phone, audio waiting", { route: "on-device", space: unsaved({ waitingBehind: 1 }, { busy: true, depth: 2 }), transcript: { inSpace: null, cloud: null, onDevice: onDevice({ stt: { state: "running", error: null } }) } }],
  ["Signed out and transcription failed", { route: "on-device", space: unsaved({ held: "signed-out" }), transcript: { inSpace: null, cloud: null, onDevice: onDevice({ stt: { state: "failed", error: "decoder crashed" } }) } }],
  ["Notes syncing", { route: "off", space: SAVED, notes: { state: "syncing" } }],
  ["Notes failed", { route: "off", space: SAVED, notes: { state: "failed" } }],
  ["Saved, part of the audio lost (notice)", { route: "off", capture: { finalizing: false, issue: "partial_audio" } }],
  ["Finishing the recording", { capture: { finalizing: true, issue: null } }],
];

function Case(props: { title: string; pipeline: NotePipeline }) {
  return (
    <section data-pipeline-case="" style={{ width: 340, padding: 12 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 600, color: "var(--dim)" }}>{props.title}</h2>
      <PipelineStepper pipeline={props.pipeline} onAction={() => {}} />
    </section>
  );
}

function Gallery() {
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  return (
    <div className={`soft-skin soft-${theme}`} data-layout="phone" style={{ minHeight: "100vh", padding: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {CASES.map(([title, patch]) => (
          <Case key={title} title={title} pipeline={notePipeline({ ...base, ...patch })} />
        ))}
      </div>
    </div>
  );
}

export const pipelineScreens: HarnessScreen[] = [
  { id: "pipeline-independent-tracks", group: "pipeline", layout: "document", render: () => <Gallery /> },
];
