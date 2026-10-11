// Where a note is on its way to your space and back: the pipeline selector's four steps as Meeting-sources dots,
// the current step's caption, and, when something needs the user, the cause with one action.
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

const ARC_RADIUS = 6;
const ARC_LENGTH = 2 * Math.PI * ARC_RADIUS;

function Bang(props: { fill: string }) {
  return (
    <>
      <path d="M8 4.6 V8.4" stroke={props.fill} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <circle cx="8" cy="11" r="0.9" fill={props.fill} />
    </>
  );
}

function Node(props: { step: PipelineStep }) {
  const { state, progress } = props.step;
  return (
    <svg className="pipeline-stepper-node" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-node-state={state}>
      {state === "done" && <circle cx="8" cy="8" r="4.5" fill="var(--ink)" />}
      {(state === "upcoming" || state === "waiting") && <circle cx="8" cy="8" r="4" fill="none" stroke="var(--line)" strokeWidth="1.5" />}
      {state === "active" && (
        <>
          <circle cx="8" cy="8" r={ARC_RADIUS} fill="none" stroke="var(--line)" strokeWidth="1.5" />
          {progress === undefined ? (
            <circle
              className="pipeline-stepper-spin"
              data-arc="unknown"
              cx="8" cy="8" r={ARC_RADIUS} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round"
              strokeDasharray={`${ARC_LENGTH * 0.25} ${ARC_LENGTH}`}
              transform="rotate(-90 8 8)"
            />
          ) : (
            <circle
              data-arc="progress"
              cx="8" cy="8" r={ARC_RADIUS} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round"
              strokeDasharray={`${ARC_LENGTH * Math.min(1, Math.max(0, progress))} ${ARC_LENGTH}`}
              transform="rotate(-90 8 8)"
            />
          )}
        </>
      )}
      {state === "blocked" && (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="var(--ink)" strokeWidth="1.5" />
          <Bang fill="var(--ink)" />
        </>
      )}
      {state === "failed" && (
        <>
          <circle cx="8" cy="8" r="7" fill="var(--ink)" />
          <Bang fill="var(--bgc)" />
        </>
      )}
    </svg>
  );
}

export function PipelineStepper(props: { pipeline: NotePipeline; onAction: (kind: PipelineActionKind) => void; className?: string }) {
  const { pipeline, onAction } = props;
  const causeId = useId();
  if (pipeline.done) return null;

  const visible = pipeline.steps.filter((step) => step.state !== "skipped");
  const currentIndex = visible.findIndex((step) => step.key === pipeline.current);
  const caption = visible.find((step) => step.key === pipeline.current)?.caption;
  const { blocker, notice } = pipeline;

  return (
    <div className={props.className ? `pipeline-stepper ${props.className}` : "pipeline-stepper"} data-pipeline-stepper="">
      <ol
        aria-label="Where this note is"
        className="pipeline-stepper-list"
        style={{ "--pipeline-step-count": visible.length } as React.CSSProperties}
      >
        {visible.map((step, index) => {
          const last = index === visible.length - 1;
          const current = index === currentIndex;
          return (
            <li key={step.key} data-step={step.key} data-state={step.state} data-current={current ? "" : undefined}>
              <span className="pipeline-stepper-indicator" aria-hidden="true">
                <Node step={step} />
                {!last && <span className="pipeline-stepper-connector" data-ink={index < currentIndex ? "" : undefined} />}
              </span>
              <span className="pipeline-stepper-label" data-current={current ? "" : undefined}>
                {step.label}
                <span className="sr-only">, {STATE_WORD[step.state]}</span>
                {step.sublabel !== undefined && <span className="pipeline-stepper-sublabel">{step.sublabel}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-pipeline-announce="">
        {blocker?.cause ?? ""}
      </p>
      {caption !== undefined && (
        <p className="pipeline-stepper-caption" data-pipeline-caption="" aria-live="polite">
          {caption}
        </p>
      )}
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
        </div>
      )}
    </div>
  );
}
