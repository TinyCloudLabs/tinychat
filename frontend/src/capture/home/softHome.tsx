// The Soft Capture home's shared state (TC-871). At a compact width the home
// and every Library row (Recent and the Library share one row) draw in the
// Soft skin. SoftHomeProvider carries what the rows need: the recorder's
// capture issues, the sheet a tap on a failed row (or on a partial-audio row's
// line) opens, and how that sheet dismisses a notice.
import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import type { CaptureIssues } from "./captureIssues";
import { IssueSheet } from "./IssueSheet";
import { useIssueController } from "./useIssueController";
import "../recorder/final/soft.css";
import "./home.css";

export interface SoftHomeValue {
  issues: CaptureIssues;
  /** Reading the sessions native parked failed (not for lack of support). */
  quarantineFailed: boolean;
  /** A tap on a row whose issue has a sheet: the recording's id, and the control to return focus to (or, if it is gone, the row, else its list's heading). */
  openIssue: (id: string, opener: HTMLElement) => void;
}

const SoftHomeContext = createContext<SoftHomeValue | null>(null);

/** Non-null where the Soft skin is on: the rows read it to choose their look. */
export function useSoftHome(): SoftHomeValue | null {
  return useContext(SoftHomeContext);
}

/** `enabled` false (any other layout) provides nothing, but stays in the tree: a resize never re-parents the pane. */
export function SoftHomeProvider(props: {
  enabled: boolean;
  /** The recorder's `captureIssues`. */
  issues: Readonly<Record<string, RecorderCaptureIssue>>;
  /** The recorder's `dismissCaptureIssue`: whether the notice is dismissed (false: it could not be saved, and still shows). */
  onDismissIssue: (id: string) => boolean;
  children: ReactNode;
}) {
  const { enabled } = props;
  const controller = useIssueController(
    enabled,
    props.issues,
    props.onDismissIssue,
  );
  const { issues, quarantineFailed, openIssue } = controller;
  const value = useMemo<SoftHomeValue | null>(
    () => (enabled ? { issues, quarantineFailed, openIssue } : null),
    [enabled, issues, quarantineFailed, openIssue],
  );
  return (
    <SoftHomeContext.Provider value={value}>
      {props.children}
      <IssueSheet {...controller.sheet} />
    </SoftHomeContext.Provider>
  );
}
