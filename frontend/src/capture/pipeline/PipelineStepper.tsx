// Independent audio and transcript statuses, with one actionable blocker when a track needs attention.
import { useId } from "react";

import type { NotePipeline, PipelineActionKind, PipelineStep, StepState } from "@/lib/voiceNotes/notePipeline";
import "../home/home.css";
import "./PipelineStepper.css";

const STATE_WORD: Record<StepState, string> = {
  done: "done",
  active: "in progress",
  waiting: "waiting",
  blocked: "needs you",
  failed: "failed",
  upcoming: "not started",
  skipped: "skipped",
};

function statusText(step: PipelineStep): string {
  if (step.caption) return step.caption;
  switch (step.state) {
    case "done": return step.key === "phone" ? "Saved on this device" : "Saved";
    case "active": return "In progress";
    case "waiting": return "Waiting";
    case "blocked": return "Needs attention";
    case "failed": return "Failed";
    case "upcoming": return "Not started";
    case "skipped": return "";
  }
}

export function PipelineStepper(props: {
  pipeline: NotePipeline;
  onAction: (kind: PipelineActionKind) => void;
  /** Why the last action did not work, shown with the blocker it belongs to. */
  actionError?: string | null;
  className?: string;
}) {
  const { pipeline, onAction } = props;
  const causeId = useId();
  if (pipeline.done) return null;

  const visible = pipeline.steps.filter((step) => step.state !== "skipped" && step.key !== "notes");
  const { blocker, notice } = pipeline;

  return (
    <div className={props.className ? `pipeline-stepper ${props.className}` : "pipeline-stepper"} data-pipeline-stepper="">
      <ul aria-label="Where this note is" className="pipeline-stepper-list">
        {visible.map((step) => (
          <li key={step.key} data-step={step.key} data-state={step.state} data-current={pipeline.current === step.key ? "" : undefined}>
            <span className="pipeline-stepper-label">{step.label}<span className="sr-only">, {STATE_WORD[step.state]}</span></span>
            <span className="pipeline-stepper-status">{step.sublabel ?? statusText(step)}</span>
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-pipeline-announce="">
        {blocker?.cause ?? ""}
      </p>
      {notice !== undefined && (
        <p className="pipeline-stepper-notice" data-pipeline-notice="">
          {notice}
        </p>
      )}
      {blocker !== undefined && (
        <div className="pipeline-stepper-blocker" data-pipeline-blocker="">
          <p className="pipeline-stepper-cause" id={causeId}>
            {blocker.cause}
          </p>
          {blocker.action !== undefined && (
            <span className="soft-pill-hit" data-hit-area="">
              <button type="button" className="soft-pill" aria-describedby={causeId} onClick={() => onAction(blocker.action!.kind)}>
                {blocker.action.label}
              </button>
            </span>
          )}
          {props.actionError != null && props.actionError !== "" && (
            <p className="pipeline-stepper-action-error" role="alert" data-pipeline-action-error="">
              {props.actionError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
