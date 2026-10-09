// One Recent / Library row in the Soft skin (TC-871): a kind tile, the title, a
// time-and-source line, then the length and a chevron. A capture issue swaps the
// tile for "!" and the state line for the issue's. Each row is one control,
// labelled with all of it: the issue is in the label, never in colour alone.
// T22 adds pipeline status to this row.
import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import {
  formatClockDuration,
  formatSpokenDuration,
} from "../library/formatters";
import { issueMeta } from "./captureIssues";
import { HOME_COPY } from "./homeCopy";

export interface SoftRowProps {
  icon: LucideIcon;
  title: string;
  /** "Today 2:18 AM" (or the source and time). */
  meta: string;
  durationSecs?: number | null;
  issue?: RecorderCaptureIssue;
  /** A destination: the row is a link. */
  href?: string;
  /** Otherwise a button (an issue's sheet); neither makes a plain, labelled row. */
  onActivate?: (row: HTMLElement) => void;
  selected?: boolean;
  testId: string;
  sourceId?: string;
}

/** The row's one accessible name: the title, what it says under it, how long, and its state. */
export function softRowLabel(
  props: Pick<
    SoftRowProps,
    "title" | "meta" | "durationSecs" | "issue" | "onActivate"
  >,
): string {
  const parts = [
    props.title,
    props.issue ? issueMeta(props.issue) : props.meta,
  ];
  if (props.durationSecs != null)
    parts.push(formatSpokenDuration(props.durationSecs));
  if (props.issue && props.issue.kind !== "finalization_timed_out")
    parts.push(HOME_COPY.needsAttention);
  if (props.issue && props.onActivate) parts.push(HOME_COPY.opensDetails);
  return parts.join(". ");
}

function Spinner() {
  return (
    <span
      className="soft-spinner"
      aria-hidden="true"
      data-testid="soft-row-spinner"
    />
  );
}

export function SoftRow(props: SoftRowProps) {
  const { issue } = props;
  const failed = issue !== undefined && issue.kind !== "finalization_timed_out";
  const Icon = props.icon;
  const label = softRowLabel(props);
  const body = (
    <>
      <span
        className="soft-tile"
        aria-hidden="true"
        data-failed={failed ? "true" : undefined}
      >
        {failed ? (
          <span className="soft-tile-bang">!</span>
        ) : (
          <Icon className="soft-ico" />
        )}
      </span>
      <span className="soft-row-text">
        <b className="soft-row-title">{props.title}</b>
        <span
          className="soft-row-meta"
          data-testid="soft-row-meta"
          data-failed={failed ? "true" : undefined}
        >
          {issue?.kind === "finalization_timed_out" && <Spinner />}
          {issue ? issueMeta(issue) : props.meta}
        </span>
      </span>
      {(props.durationSecs != null ||
        props.href !== undefined ||
        props.onActivate) && (
        <span className="soft-row-aside" aria-hidden="true">
          {props.durationSecs != null && (
            <span className="tnum">
              {formatClockDuration(props.durationSecs)}
            </span>
          )}
          {(props.href !== undefined || props.onActivate) && (
            <ChevronRightIcon className="soft-chev" />
          )}
        </span>
      )}
    </>
  );
  const common = {
    className: "soft-row",
    "aria-label": label,
    "data-selected": props.selected ? "true" : undefined,
  };
  return (
    <li
      className="soft-row-item"
      data-testid={props.testId}
      data-source-id={props.sourceId}
      data-issue={issue?.kind}
    >
      {props.href !== undefined ? (
        <Link
          to={props.href}
          {...common}
          aria-current={props.selected ? "page" : undefined}
        >
          {body}
        </Link>
      ) : props.onActivate ? (
        <button
          type="button"
          onClick={(event) => props.onActivate?.(event.currentTarget)}
          {...common}
        >
          {body}
        </button>
      ) : (
        <div role="group" {...common}>
          {body}
        </div>
      )}
    </li>
  );
}
