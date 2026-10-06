// Capture's home (TC-761, PR6) in the real shell (harness/ShellApp.tsx): first
// use in an empty space, with items (In progress, Recent; the Library beside
// it from medium up), an upload waiting in In progress, a recording minimised
// to the island (the rail or the sidebar on wider screens), and the web.
import { useContext, useMemo, type ReactNode } from "react";

import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
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
