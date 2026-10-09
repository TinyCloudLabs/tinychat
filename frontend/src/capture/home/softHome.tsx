// The Soft Capture home's switch and shared state (TC-871). Behind the
// recorder-final flag, on a phone only (the tab bar nav, compact width), the
// home and every Library row (Recent and the Library share one row) draw in
// the Soft skin. SoftHomeProvider carries what the rows need: the recorder's
// capture issues and the sheet a tap on a failed row opens.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { recorderFinalEnabled } from "../recorder/final/recorderFinalFlag";
import { sheetIssue, type CaptureIssues } from "./captureIssues";
import { IssueSheet } from "./IssueSheet";
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
  issues: CaptureIssues;
  children: ReactNode;
}) {
  const [sheetId, setSheetId] = useState<string | null>(null);
  const { enabled, issues } = props;
  // The sheet shows the provider's current issue for the recording: when it clears (a save went through), the sheet closes.
  const issue = sheetIssue(sheetId, issues, enabled);
  useEffect(() => {
    if (sheetId !== null && issue === null) setSheetId(null);
  }, [sheetId, issue]);
  // The sheet has no Dialog.Trigger, so Radix can't return focus on its own. The row is passed in: WebKit doesn't focus a tapped button.
  const opener = useRef<HTMLElement | null>(null);
  // The row disappears when its issue clears (the sheet closes then), so focus has a stable place to land: the heading of the list the row was in.
  const fallback = useRef<HTMLElement | null>(null);
  const openIssue = useCallback((id: string, row: HTMLElement) => {
    opener.current = row;
    const scope = row.closest<HTMLElement>("[data-return-focus]");
    fallback.current =
      scope?.querySelector<HTMLElement>("[data-return-focus-target]") ?? scope;
    setSheetId(id);
  }, []);
  const value = useMemo<SoftHomeValue | null>(
    () => (enabled ? { issues, openIssue } : null),
    [enabled, issues, openIssue],
  );
  return (
    <SoftHomeContext.Provider value={value}>
      {props.children}
      <IssueSheet
        issue={issue}
        returnFocusTo={opener}
        fallbackFocusTo={fallback}
        onClose={() => setSheetId(null)}
      />
    </SoftHomeContext.Provider>
  );
}
