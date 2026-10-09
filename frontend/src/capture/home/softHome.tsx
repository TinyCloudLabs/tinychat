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
import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import { useQuarantinedRecordings } from "@/lib/voiceNotes/quarantine";
import {
  recoveryFailedKey,
  sheetIssue,
  withQuarantine,
  type CaptureIssues,
} from "./captureIssues";
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
  const [sheetId, setSheetId] = useState<string | null>(null);
  const { enabled } = props;
  // Read the parked sessions again whenever a recording newly fails recovery.
  const quarantine = useQuarantinedRecordings(
    enabled,
    recoveryFailedKey(props.issues),
  );
  // Recordings deleted (or found no longer failed) from the sheet: native has dropped them, the recorder's issue map has not.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const markGone = useCallback(
    (id: string) => setGone((current) => new Set(current).add(id)),
    [],
  );
  const issues = useMemo<CaptureIssues>(
    () =>
      withQuarantine(
        props.issues,
        quarantine.items.map((item) => item.id),
        gone,
      ),
    [props.issues, quarantine.items, gone],
  );
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
    () =>
      enabled
        ? { issues, quarantineFailed: quarantine.error !== null, openIssue }
        : null,
    [enabled, issues, quarantine.error, openIssue],
  );
  return (
    <SoftHomeContext.Provider value={value}>
      {props.children}
      <IssueSheet
        id={sheetId}
        issue={issue}
        refresh={quarantine.refresh}
        onGone={markGone}
        returnFocusTo={opener}
        fallbackFocusTo={fallback}
        onClose={() => setSheetId(null)}
      />
    </SoftHomeContext.Provider>
  );
}
