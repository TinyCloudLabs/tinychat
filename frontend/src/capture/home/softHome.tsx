// The Soft Capture home's switch and shared state (TC-871). Behind the
// recorder-final flag, on a phone only (the tab bar nav, compact width), the
// home and every Library row (Recent and the Library share one row) draw in
// the Soft skin. SoftHomeProvider carries what the rows need: the recorder's
// capture issues and the sheet a tap on a failed row opens.
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { recorderFinalEnabled } from "../recorder/final/recorderFinalFlag";
import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import type { CaptureIssues } from "./captureIssues";
import { IssueSheet } from "./IssueSheet";
import { useIssueController } from "./useIssueController";
import "../recorder/final/soft.css";
import "./home.css";

let forced: boolean | null = null;

/**
 * The screenshot harness builds with no env, so it turns the skin on here.
 * Never called by the app.
 */
export function forceSoftHome(on: boolean | null): void {
  forced = on;
}

export function softHomeEnabled(): boolean {
  return forced ?? recorderFinalEnabled();
}

export interface SoftHomeValue {
  issues: CaptureIssues;
  /** Reading the sessions native parked failed (not for lack of support). */
  quarantineFailed: boolean;
  /** A tap on a row whose issue has a sheet: the recording's id, and the row to return focus to (or, if it is gone, its list's heading). */
  openIssue: (id: string, opener: HTMLElement) => void;
}

const SoftHomeContext = createContext<SoftHomeValue | null>(null);

/** Non-null where the Soft skin is on: the rows read it to choose their look. */
export function useSoftHome(): SoftHomeValue | null {
  return useContext(SoftHomeContext);
}

/** `enabled` false (any other layout, flag off) provides nothing, but stays in the tree: a resize never re-parents the pane. */
export function SoftHomeProvider(props: {
  enabled: boolean;
  /** The recorder's `captureIssues`. */
  issues: Readonly<Record<string, RecorderCaptureIssue>>;
  children: ReactNode;
}) {
  const { enabled } = props;
  const controller = useIssueController(enabled, props.issues);
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
