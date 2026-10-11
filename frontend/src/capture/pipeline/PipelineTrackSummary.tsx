import type { NotePipeline, PipelineStep } from "@/lib/voiceNotes/notePipeline";

function detail(step: PipelineStep, done: string): string {
  if (step.caption) return step.caption;
  if (step.blocker) return step.blocker.cause;
  if (step.state === "done") return done;
  if (step.state === "failed") return "Failed";
  if (step.state === "blocked") return "Needs attention";
  if (step.state === "active") return "In progress";
  if (step.state === "upcoming") return "Not started";
  return "Waiting";
}

export function pipelineTrackLabel(pipeline: NotePipeline): string {
  const phone = pipeline.steps.find((step) => step.key === "phone");
  const space = pipeline.steps.find((step) => step.key === "space");
  const transcript = pipeline.steps.find((step) => step.key === "transcript");
  return [
    phone && `Audio on this device: ${detail(phone, "Saved")}`,
    space && space.state !== "skipped" && `Audio in your space: ${detail(space, "Saved")}`,
    transcript && transcript.state !== "skipped" && `Transcript: ${detail(transcript, "Saved")}`,
  ].filter(Boolean).join(". ");
}

export function PipelineTrackSummary(props: { pipeline: NotePipeline }) {
  const phone = props.pipeline.steps.find((step) => step.key === "phone");
  const space = props.pipeline.steps.find((step) => step.key === "space");
  const transcript = props.pipeline.steps.find((step) => step.key === "transcript");
  const audio = [
    phone && `On this device · ${detail(phone, "Saved")}`,
    space && space.state !== "skipped" && `In your space · ${detail(space, "Saved")}`,
  ].filter(Boolean).join(" · ");
  return (
    <span className="pipeline-track-summary" data-pipeline-track-summary="">
      {audio && <span>Audio: {audio}</span>}
      {transcript && transcript.state !== "skipped" && <span>Transcript: {detail(transcript, "Saved")}</span>}
    </span>
  );
}
