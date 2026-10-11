import { MicIcon } from "lucide-react";

import { pipelineActionPriority, type NotePipeline, type PipelineActionKind } from "@/lib/voiceNotes/notePipeline";
import { PipelineTrackSummary, pipelineTrackLabel } from "../pipeline/PipelineTrackSummary";
import { HOME_COPY } from "./homeCopy";

export interface InProgressNoteRow {
  id: string;
  pipelineId?: string;
  title: string;
  duration: string | null;
  spokenDuration?: string | null;
  pipeline: NotePipeline;
}

export interface ModelProgress {
  bytes: number;
  totalBytes: number;
}

function currentCaption(pipeline: NotePipeline): string {
  const current = pipeline.steps.find((step) => step.key === pipeline.current);
  return current?.caption ?? current?.blocker?.cause ?? current?.label ?? "In progress";
}

function modelWaiting(pipeline: NotePipeline): boolean {
  const transcript = pipeline.steps.find((step) => step.key === "transcript");
  return transcript?.blocker?.action?.kind === "get-model" || transcript?.caption?.startsWith("Waiting for the on-device model") === true;
}

function megabytes(bytes: number): string {
  return String(Math.round(Math.max(0, bytes) / 1_000_000));
}

/** Presentational card for unfinished voice notes. The caller owns subscriptions and action execution. */
export function InProgressVoiceCard(props: {
  rows: readonly InProgressNoteRow[];
  model?: ModelProgress | null;
  onOpen: (id: string) => void;
  onAction: (kind: PipelineActionKind, noteId: string) => void;
  onSaveNow?: () => void;
  onOpenLibrary: () => void;
  actionError?: string | null;
}) {
  const unfinished = props.rows.filter((row) => !row.pipeline.done);
  if (unfinished.length === 0) return null;

  const uploading = unfinished.filter((row) => {
    const current = row.pipeline.steps.find((step) => step.key === row.pipeline.current);
    return current?.key === "space" && current.state === "active" && current.caption?.startsWith("Uploading") === true;
  }).length;
  const onPhone = unfinished.filter((row) => row.pipeline.steps.find((step) => step.key === "space")?.state !== "done").length;
  const action = unfinished
    .flatMap((row) => {
      const kind = row.pipeline.blocker?.action?.kind;
      return kind ? [{ kind, noteId: row.pipelineId ?? row.id, label: row.pipeline.blocker!.action!.label }] : [];
    })
    .sort((a, b) => pipelineActionPriority(b.kind) - pipelineActionPriority(a.kind))[0];
  const hasOffline = unfinished.some((row) => currentCaption(row.pipeline).startsWith("Waiting for a connection"));
  const showModel = unfinished.some((row) => modelWaiting(row.pipeline));
  const rows = unfinished.slice(0, 3);

  return (
    <div className="soft-card soft-progress-card" data-testid="voice-note-pending">
      <MicIcon className="soft-ico soft-card-icon" aria-hidden="true" />
      <div className="soft-card-text">
        <b data-testid="voice-note-summary">{HOME_COPY.inProgressCount(unfinished.length)}</b>
        {onPhone > 0 && <span data-testid="voice-note-on-phone">{HOME_COPY.onPhoneCount(onPhone)}</span>}
        {uploading > 0 && <span data-testid="voice-note-uploading">{uploading} uploading</span>}
        {hasOffline && <span data-testid="voice-note-offline">Waiting for a connection. Exo continues automatically.</span>}
        {props.actionError && <span role="alert" data-testid="voice-note-action-error">{props.actionError}</span>}
      </div>
      {action && (
        <span className="soft-pill-hit" data-hit-area="">
          <button type="button" className="soft-pill" onClick={() => props.onAction(action.kind, action.noteId)} data-testid="voice-note-action">
            {action.label}
          </button>
        </span>
      )}
      {!action && props.onSaveNow && (
        <span className="soft-pill-hit" data-hit-area="">
          <button type="button" className="soft-pill" onClick={props.onSaveNow} data-testid="voice-note-retry">
            <span data-testid="voice-note-save-now">{HOME_COPY.saveNow}</span>
          </button>
        </span>
      )}
      <ul className="soft-progress-rows" data-testid="voice-note-progress-rows">
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" className="soft-progress-row" aria-label={`${row.title}. ${pipelineTrackLabel(row.pipeline)}${row.spokenDuration ? `. ${row.spokenDuration}` : ""}`} onClick={() => props.onOpen(row.id)}>
              <span className="soft-tile" aria-hidden="true"><MicIcon className="soft-ico" /></span>
              <span className="soft-row-text">
                <b className="soft-row-title">{row.title}</b>
                <span className="soft-row-meta"><PipelineTrackSummary pipeline={row.pipeline} /></span>
              </span>
              <span className="soft-row-aside" aria-hidden="true">
                {row.duration && <span className="tnum">{row.duration}</span>}
              </span>
            </button>
          </li>
        ))}
        {unfinished.length > 3 && (
          <li><button type="button" className="soft-progress-more" onClick={props.onOpenLibrary}>+{unfinished.length - 3} more</button></li>
        )}
        {showModel && props.model && (
          <li className="soft-model-progress" data-testid="on-device-model-progress">
            <span>On-device model</span>
            <span className="tnum">{megabytes(props.model.bytes)} of {megabytes(props.model.totalBytes)} MB</span>
          </li>
        )}
      </ul>
    </div>
  );
}
