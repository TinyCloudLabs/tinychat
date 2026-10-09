// The Soft Capture home's switch and shared state (TC-871). Behind the
// recorder-final flag, on a phone only (the tab bar nav, compact width), the
// home and every Library row (Recent and the Library share one row) draw in
// the Soft skin. SoftHomeProvider carries what the rows need: the recorder's
// capture issues, the note titles the data has, and the sheet a tap on a
// failed row opens.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { recorderFinalEnabled } from "../recorder/final/recorderFinalFlag";
import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import type { CaptureIssues } from "./captureIssues";
import { IssueSheet } from "./IssueSheet";
import "../recorder/final/soft.css";
import "./home.css";

let forced: boolean | null = null;
let forcedNoteTitles: ReadonlyMap<string, string> | undefined;

/**
 * The screenshot harness builds with no env, so it turns the skin on here, and
 * names the notes some rows have (the data has none yet). Never called by the app.
 */
export function forceSoftHome(
  on: boolean | null,
  noteTitles?: ReadonlyMap<string, string>,
): void {
  forced = on;
  forcedNoteTitles = noteTitles;
}

export function softHomeEnabled(): boolean {
  return forced ?? recorderFinalEnabled();
}

export function softHomeNoteTitles(): ReadonlyMap<string, string> | undefined {
  return forcedNoteTitles;
}

export interface SoftHomeValue {
  issues: CaptureIssues;
  /** A note's title by Library item id, where the data has one. */
  noteTitles: ReadonlyMap<string, string>;
  /** A tap on a row whose issue has a sheet. */
  openIssue: (issue: RecorderCaptureIssue, opener: HTMLElement) => void;
}

const SoftHomeContext = createContext<SoftHomeValue | null>(null);

/** Non-null where the Soft skin is on: the rows read it to choose their look. */
export function useSoftHome(): SoftHomeValue | null {
  return useContext(SoftHomeContext);
}

const NO_NOTES: ReadonlyMap<string, string> = new Map();

/** `enabled` false (any other layout, flag off) provides nothing, but stays in the tree: a resize never re-parents the pane. */
export function SoftHomeProvider(props: {
  enabled: boolean;
  issues: CaptureIssues;
  noteTitles?: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  const [sheetIssue, setSheetIssue] = useState<RecorderCaptureIssue | null>(
    null,
  );
  const { enabled, issues, noteTitles } = props;
  // The sheet has no Dialog.Trigger, so Radix can't return focus on its own. The row is passed in: WebKit doesn't focus a tapped button.
  const opener = useRef<HTMLElement | null>(null);
  const openIssue = useCallback(
    (issue: RecorderCaptureIssue, row: HTMLElement) => {
      opener.current = row;
      setSheetIssue(issue);
    },
    [],
  );
  const value = useMemo<SoftHomeValue | null>(
    () =>
      enabled
        ? { issues, noteTitles: noteTitles ?? NO_NOTES, openIssue }
        : null,
    [enabled, issues, noteTitles, openIssue],
  );
  return (
    <SoftHomeContext.Provider value={value}>
      {props.children}
      <IssueSheet
        issue={sheetIssue}
        returnFocusTo={opener}
        onClose={() => setSheetIssue(null)}
      />
    </SoftHomeContext.Provider>
  );
}
