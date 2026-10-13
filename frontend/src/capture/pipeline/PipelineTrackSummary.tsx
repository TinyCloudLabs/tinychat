import type { NotePipeline, PipelineStep } from "@/lib/voiceNotes/notePipeline";
import { voiceNoteTranscriptionFailureForCode } from "@/lib/voiceNotes/transcriptionErrors";


function detail(step: PipelineStep, done: string): string {
  if (step.sublabel) return step.sublabel;
  if (step.blocker?.action?.kind === "sign-in") return "Needs sign-in";
  if (step.caption) return step.caption;
  if (step.blocker) return "Needs attention";
  if (step.state === "done") return done;
  if (step.state === "failed") return "Failed";
  if (step.state === "blocked") return "Needs attention";
  if (step.state === "active") return "In progress";
  if (step.state === "upcoming") return "Not started";
  return "Waiting";
}

/** The durable row state matters when the live transcript route is otherwise skipped. */
export function pipelineTranscriptStatus(pipeline: NotePipeline): string | null {
  const transcript = pipeline.steps.find((step) => step.key === "transcript");
  if ((transcript?.state !== "skipped" && transcript?.state !== "waiting") || pipeline.transcriptionState === undefined) return null;
  const state = pipeline.transcriptionState === "pending"
    ? "Pending"
    : pipeline.transcriptionState === "failed" ? "Failed" : "Not transcribed";
  const reason = pipeline.transcriptionState === "failed" && pipeline.transcriptionErrorCode
    ? ` · ${voiceNoteTranscriptionFailureForCode(pipeline.transcriptionErrorCode).message}`
    : "";
  return `Transcript ${state}${reason}`;
}

export function pipelineTrackLabel(pipeline: NotePipeline): string {
  const phone = pipeline.steps.find((step) => step.key === "phone");
  const space = pipeline.steps.find((step) => step.key === "space");
  const transcript = pipeline.steps.find((step) => step.key === "transcript");
  const transcriptStatus = pipelineTranscriptStatus(pipeline);
  return [
    phone && `${phone.label}: ${detail(phone, "Saved")}`,
    space && space.state !== "skipped" && `Audio in your space: ${detail(space, "Saved")}`,
    transcript && transcript.state !== "skipped" && `Transcript: ${detail(transcript, "Saved")}`,
    transcriptStatus,
  ].filter(Boolean).join(". ");
}

export function PipelineTrackSummary(props: { pipeline: NotePipeline }) {
  const phone = props.pipeline.steps.find((step) => step.key === "phone");
  const space = props.pipeline.steps.find((step) => step.key === "space");
  const transcript = props.pipeline.steps.find((step) => step.key === "transcript");
  const transcriptStatus = pipelineTranscriptStatus(props.pipeline);
  const audio = [
    phone && phone.state !== "done" && `${phone.label.replace(/^Audio /, "")} · ${detail(phone, "Saved")}`,
    space && space.state !== "skipped" && detail(space, "Saved"),
  ].filter(Boolean).join(" · ");
  return (
    <span className="pipeline-track-summary" data-pipeline-track-summary="">
      {audio && <span>Audio: {audio}</span>}
      {transcript && transcript.state !== "skipped" && <span>Transcript: {detail(transcript, "Saved")}</span>}
      {transcriptStatus && <span>{transcriptStatus}</span>}
      {props.pipeline.steps.some((step) => step.key === "notes" && step.state !== "skipped" && step.state !== "done") && <span>Notes: {detail(props.pipeline.steps.find((step) => step.key === "notes")!, "Saved")}</span>}
    </span>
  );
}

