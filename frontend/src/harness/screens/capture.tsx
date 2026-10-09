// Capture's home (TC-761, PR6) in the real shell (harness/ShellApp.tsx): first
// use in an empty space, with items (In progress, Recent; the Library beside
// it from medium up), an upload waiting in In progress, a recording minimised
// to the island (the rail or the sidebar on wider screens), and the web.
import { useContext, useMemo, useState, type ReactNode } from "react";

import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
import { forceSoftHome } from "@/capture/home/softHome";
import { pausedUpload } from "@/capture/upload/pausedUpload";
import { PlatformContext } from "@/lib/platform";
import { LIBRARY_ROWS, libraryTcw } from "../fixtures/library";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";
import { FROZEN_NOW } from "../stubs";

export function CaptureShell(props: {
  library?: boolean;
  /** The fixture rows to store (default: all of them). */
  rows?: typeof LIBRARY_ROWS;
  hang?: boolean;
  recorder?: Partial<RecorderValue>;
  children?: ReactNode;
}) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  const tcw = useMemo(
    () => (props.library ? libraryTcw({ rows: props.rows, hang: props.hang }) : undefined),
    [props.library, props.rows, props.hang],
  );
  return (
    <>
      <ShellApp platform={platform} shim={shim} state="ready" captureTcw={tcw} recorder={props.recorder} />
      {props.children}
    </>
  );
}

function InProgress() {
  // An own-key upload a reload interrupted, waiting for Continue.
  pausedUpload.set({ fileName: "Interview.m4a" });
  return <CaptureShell library />;
}

const MINIMISED: Partial<RecorderValue> = {
  available: true,
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: FROZEN_NOW - (12 * 60 + 48) * 1000,
  sheetOpen: false,
};

const CAPTURE = { group: "capture", layout: "pane", displayTitle: true, path: "/chat/capture", platform: "ios" } as const;
const LISTED = '[data-testid="library-list"][data-state="ready"]';

export const captureScreens: HarnessScreen[] = [
  { ...CAPTURE, id: "capture-first-use", readyWhen: LISTED, render: () => <CaptureShell /> },
  { ...CAPTURE, id: "capture-items", readyWhen: LISTED, render: () => <CaptureShell library /> },
  { ...CAPTURE, id: "capture-in-progress", readyWhen: LISTED, render: () => <InProgress /> },
  {
    ...CAPTURE,
    id: "capture-recording-minimised",
    readyWhen: LISTED,
    render: () => <CaptureShell library recorder={MINIMISED} />,
  },
  { ...CAPTURE, id: "capture-web", platform: "web", readyWhen: LISTED, render: () => <CaptureShell /> },
];

// The Soft-skin phone Capture home (TC-871, behind VITE_EXO_RECORDER_FINAL; the
// harness has no env, so each screen turns the skin on). Night and Day come
// from the harness's themes.
// The Soft skin sets its title in Fraunces, so the Literata font check does not apply.
const SOFT = { ...CAPTURE, platform: "ios", readyWhen: LISTED, displayTitle: false } as const;

function SoftHome(props: { recorder?: Partial<RecorderValue>; library?: boolean; rows?: typeof LIBRARY_ROWS }) {
  forceSoftHome(true);
  return <CaptureShell library={props.library ?? true} rows={props.rows} recorder={props.recorder ?? SOFT_IDLE} />;
}

const SOFT_IDLE: Partial<RecorderValue> = { available: true, ready: true };
declare global {
  interface Window {
    exoUiRetryPending?: number;
    /** The provider clears every capture issue (a save went through), for the interactive screen. */
    exoUiClearIssues?: () => void;
  }
}
const ON_PHONE: Partial<RecorderValue> = {
  ...SOFT_IDLE,
  pending: { listing: { state: "ok", count: 2 }, running: false, lastError: null },
  retryPending: () => {
    window.exoUiRetryPending = (window.exoUiRetryPending ?? 0) + 1;
  },
};
const TIMED_OUT: Partial<RecorderValue> = { ...SOFT_IDLE, captureIssues: { "rec-saving": { kind: "finalization_timed_out" } } };
const RECOVERY_FAILED: Partial<RecorderValue> = {
  ...SOFT_IDLE,
  captureIssues: { "rec-lost": { kind: "recoveryFailed", detail: "native: segment unreadable" } },
};
const WRITE_FAILED: Partial<RecorderValue> = {
  ...SOFT_IDLE,
  captureIssues: { "rec-partial": { kind: "write_failed", detail: "native: EIO" } },
};
const SCAN_FAILED: Partial<RecorderValue> = { ...SOFT_IDLE, recoveryScanFailure: "native: listing failed" };
const ISSUES_WITH_CARD: Partial<RecorderValue> = {
  ...ON_PHONE,
  captureIssues: { "rec-saving": { kind: "finalization_timed_out" }, "rec-lost": { kind: "recoveryFailed", detail: "native: segment unreadable" } },
};

// Titles and lengths at their longest, for the 320 px phone.
const LONG_ROWS: typeof LIBRARY_ROWS = [
  {
    ...LIBRARY_ROWS[1],
    id: "note-long-title",
    title: "Quarterly planning offsite: venue, budget and the Friday agenda for everyone on the thread",
    durationSecs: 11 * 3600 + 59 * 60 + 59,
  },
  { ...LIBRARY_ROWS[1], id: "note-long-word", title: "Supercalifragilisticexpialidocious-recording-from-the-customer-interview-2026-10-06", durationSecs: 3725 },
  LIBRARY_ROWS[0],
];

function ClearableIssues(props: { issues: NonNullable<RecorderValue["captureIssues"]> }) {
  const [issues, setIssues] = useState(props.issues);
  window.exoUiClearIssues = () => setIssues({});
  const recorder = useMemo<Partial<RecorderValue>>(() => ({ ...SOFT_IDLE, captureIssues: issues }), [issues]);
  return <SoftHome recorder={recorder} />;
}
const LOST = { "rec-lost": { kind: "recoveryFailed", detail: "native: segment unreadable" } } as const;
const SAVING = { "rec-saving": { kind: "finalization_timed_out" } } as const;

export const captureSoftScreens: HarnessScreen[] = [
  { ...SOFT, id: "capture-soft-notes", render: () => <SoftHome /> },
  { ...SOFT, id: "capture-soft-long-titles", render: () => <SoftHome rows={LONG_ROWS} /> },
  { ...SOFT, id: "capture-soft-empty", render: () => <SoftHome library={false} /> },
  { ...SOFT, id: "capture-soft-on-phone", render: () => <SoftHome recorder={ON_PHONE} /> },
  { ...SOFT, id: "capture-soft-timed-out", render: () => <SoftHome recorder={TIMED_OUT} /> },
  { ...SOFT, id: "capture-soft-recovery-failed", render: () => <SoftHome recorder={RECOVERY_FAILED} /> },
  { ...SOFT, id: "capture-soft-write-failed", render: () => <SoftHome recorder={WRITE_FAILED} /> },
  { ...SOFT, id: "capture-soft-scan-failure", render: () => <SoftHome recorder={SCAN_FAILED} /> },
  { ...SOFT, id: "capture-soft-library-issue", path: "/chat/capture/library", render: () => <SoftHome recorder={RECOVERY_FAILED} /> },
  { ...SOFT, id: "capture-soft-clearing-failed", interactive: true, render: () => <ClearableIssues issues={LOST} /> },
  { ...SOFT, id: "capture-soft-clearing-saving", interactive: true, render: () => <ClearableIssues issues={SAVING} /> },
  {
    ...SOFT,
    id: "capture-soft-clearing-library",
    path: "/chat/capture/library",
    interactive: true,
    render: () => <ClearableIssues issues={LOST} />,
  },
  { ...SOFT, id: "capture-soft-override", render: () => <SoftHome recorder={ISSUES_WITH_CARD} /> },
];
