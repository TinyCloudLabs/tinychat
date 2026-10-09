// The capture-issue state behind the failed-recording sheet (TC-871, TC-868),
// shared by the phone's SoftHomeProvider and the desktop home: the recorder's
// issues merged with what native parked, the open sheet's recording, and where
// focus goes when it closes.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";

import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import { useQuarantinedRecordings } from "@/lib/voiceNotes/quarantine";
import {
  recoveryFailedKey,
  sheetIssue,
  withQuarantine,
  type CaptureIssues,
} from "./captureIssues";
import type { IssueSheet } from "./IssueSheet";

export interface IssueController {
  issues: CaptureIssues;
  /** Reading the sessions native parked failed (not for lack of support). */
  quarantineFailed: boolean;
  /** A tap on a row whose issue has a sheet: the recording's id, and the row to return focus to (or, if it is gone, its list's heading). */
  openIssue: (id: string, opener: HTMLElement) => void;
  /** What `IssueSheet` needs, less its layout. */
  sheet: Pick<
    ComponentProps<typeof IssueSheet>,
    | "id"
    | "issue"
    | "refresh"
    | "onGone"
    | "returnFocusTo"
    | "fallbackFocusTo"
    | "onClose"
  >;
}

export function useIssueController(
  enabled: boolean,
  recorderIssues: Readonly<Record<string, RecorderCaptureIssue>>,
): IssueController {
  const [sheetId, setSheetId] = useState<string | null>(null);
  // Read the parked sessions again whenever a recording newly fails recovery.
  const quarantine = useQuarantinedRecordings(
    enabled,
    recoveryFailedKey(recorderIssues),
  );
  // Recordings deleted (or found no longer failed) from the sheet: native has dropped them, the recorder's issue map has not.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const markGone = useCallback(
    (id: string) => setGone((current) => new Set(current).add(id)),
    [],
  );
  const issues = useMemo<CaptureIssues>(
    () => withQuarantine(recorderIssues, quarantine.items, gone),
    [recorderIssues, quarantine.items, gone],
  );
  // The sheet shows the current issue for the recording: when it clears (a save went through), the sheet closes.
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
  const onClose = useCallback(() => setSheetId(null), []);
  return {
    issues,
    quarantineFailed: quarantine.error !== null,
    openIssue,
    sheet: {
      id: sheetId,
      issue,
      refresh: quarantine.refresh,
      onGone: markGone,
      returnFocusTo: opener,
      fallbackFocusTo: fallback,
      onClose,
    },
  };
}
