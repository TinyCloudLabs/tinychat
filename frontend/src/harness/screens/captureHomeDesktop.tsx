// The desktop Capture home (D2) in the real shell, wide layout (the rail from 768, the sidebar from 1024):
// idle, docked, after a stop, with capture issues and empty, in the Tauri app and (idle) on the web. The
// harness build has no env, so each screen turns the Soft skin on. The interactive screen runs the real
// recorder over the fake native plugin on the Library fixture, for test/capture-home-desktop.e2e.test.ts.
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { showToast } from "@/capture/recorder/final/desktop/Toasts";
import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { __setOnDeviceSttForTests } from "@/lib/voiceNotes/onDeviceStt";
import { LIBRARY_ROWS, libraryTcw } from "../fixtures/library";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";
import { FROZEN_NOW } from "../stubs";
import { installFailedNative } from "./capture";
import { installNativePlugin, ON_DEVICE_STT } from "./recorderFinalDesktop";

// Where captureHomeKind picks the desktop home: a rail or sidebar at a medium or expanded size class. A phone on its side (844x390) is a compact rail, which keeps today's home.
const DESKTOP_HOME_VIEWPORTS = ["tablet", "tablet-land", "desktop-min", "desktop", "text200-desktop"];

const LISTED =
  '[data-testid="recent-item"], [data-testid="capture-recent-empty"]';

function Home(props: {
  recorder?: Partial<RecorderValue>;
  rows?: typeof LIBRARY_ROWS;
  toast?: string;
}) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  const tcw = useMemo(() => libraryTcw({ rows: props.rows }), [props.rows]);
  const { toast } = props;
  useEffect(() => {
    if (toast) showToast(toast);
  }, [toast]);
  return (
    <ShellApp
      platform={platform}
      shim={shim}
      state="ready"
      captureTcw={tcw}
      recorder={props.recorder}
    />
  );
}

const IDLE: Partial<RecorderValue> = {
  available: true,
  ready: true,
  phase: "idle",
};

const DOCKED: Partial<RecorderValue> = {
  ...IDLE,
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: FROZEN_NOW - 42_000,
  audioMs: 42_000,
  elapsedMs: 42_000,
  elapsedAt: FROZEN_NOW,
  sheetOpen: false,
};

const ISSUES: Partial<RecorderValue> = {
  ...IDLE,
  pending: {
    listing: { state: "ok", count: 2 },
    running: false,
    lastError: null,
  },
  retryPending: () => {},
  captureIssues: {
    "rec-0928": { kind: "partial_audio", missingMs: 4000 },
    "rec-saving": { kind: "finalization_timed_out" },
    "rec-lost": {
      kind: "recoveryFailed",
      detail: "native: segment unreadable",
    },
  },
};

const LOST: NonNullable<RecorderValue["captureIssues"]> = {
  "rec-lost": { kind: "recoveryFailed", detail: "native: segment unreadable" },
  // A voice note already in the Library (rec-0802) whose recovery failed.
  "rec-0802": { kind: "recoveryFailed", detail: "native: segment unreadable" },
};
const LOST_ROW = '[data-testid="capture-recent"] li[data-issue="recoveryFailed"] button';
const SHEET = '[data-testid="capture-issue-sheet"]';
const CONFIRM = '[role="alertdialog"]';

/** The failed-recording actions over the fake native plugin (window.exoUiFailed); Try again clears the issues, as the recorder does. */
function FailedHome(props: {
  parked?: string[];
  /** A row to click once it is there, and (confirm) the Delete to press after it. */
  open?: string;
  confirm?: boolean;
}) {
  useState(() => {
    const plugin = installNativePlugin();
    __setOnDeviceSttForTests(ON_DEVICE_STT);
    installFailedNative(props.parked ?? ["rec-parked"], {}, plugin);
  });
  const [issues, setIssues] = useState(LOST);
  window.exoUiClearIssues = () => setIssues({});
  const recorder = useMemo<Partial<RecorderValue>>(
    () => ({ ...IDLE, captureIssues: issues }),
    [issues],
  );
  useEffect(() => {
    if (!props.open) return;
    const timer = setInterval(() => {
      const row = document.querySelector<HTMLElement>(props.open!);
      if (!row) return;
      row.click();
      clearInterval(timer);
      if (props.confirm)
        setTimeout(
          () => document.querySelector<HTMLElement>('[data-testid="capture-issue-delete"]')?.click(),
          100,
        );
    }, 50);
    return () => clearInterval(timer);
  }, [props.open, props.confirm]);
  return <Home recorder={recorder} />;
}

const PARTIAL: NonNullable<RecorderValue["captureIssues"]> = {
  "rec-0928": { kind: "partial_audio", missingMs: 4000 },
};

/** The Recent row's Dismiss over `window.exoUiDismiss`: the ids it was called with, and how the next call fails (`false`: not saved; `throw`). */
function DismissHome() {
  const [issues, setIssues] = useState(PARTIAL);
  const [dismiss] = useState<NonNullable<Window["exoUiDismiss"]>>(() => ({ calls: [], fail: null }));
  window.exoUiDismiss = dismiss;
  const recorder = useMemo<Partial<RecorderValue>>(
    () => ({
      ...IDLE,
      captureIssues: issues,
      dismissCaptureIssue: (id) => {
        dismiss.calls.push(id);
        if (dismiss.fail === "throw") throw new Error("native: storage unavailable");
        if (dismiss.fail === "false") return false;
        setIssues((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
        return true;
      },
    }),
    [issues, dismiss],
  );
  return <Home recorder={recorder} />;
}

const screen = (
  id: string,
  render: () => ReactNode,
  platform: HarnessScreen["platform"] = "tauri",
): HarnessScreen => ({
  id: `capture-home-desktop-${id}`,
  group: "captureHomeDesktop",
  layout: "pane",
  displayTitle: false,
  path: "/chat/capture",
  platform,
  viewports: DESKTOP_HOME_VIEWPORTS,
  readyWhen: LISTED,
  render,
});

const interactiveScreen: HarnessScreen = {
  id: "capture-home-desktop-interactive",
  group: "captureHomeDesktop",
  layout: "pane",
  displayTitle: false,
  path: "/chat/capture",
  platform: "tauri",
  viewports: DESKTOP_HOME_VIEWPORTS,
  interactive: true,
  render: () => {
    installNativePlugin();
    __setOnDeviceSttForTests(ON_DEVICE_STT);
    return <Home />;
  },
};

export const captureHomeDesktopScreens: HarnessScreen[] = [
  interactiveScreen,
  {
    ...screen("failed", () => <FailedHome />),
    interactive: true,
  },
  {
    ...screen("dismiss", () => <DismissHome />),
    interactive: true,
  },
  { ...screen("failed-sheet", () => <FailedHome open={LOST_ROW} />), readyWhen: SHEET },
  {
    ...screen("failed-confirm", () => <FailedHome open={LOST_ROW} confirm />),
    readyWhen: CONFIRM,
  },
  screen("idle", () => <Home recorder={IDLE} />),
  screen("idle-web", () => <Home recorder={IDLE} />, "web"),
  screen("docked", () => <Home recorder={DOCKED} />),
  screen("docked-web", () => <Home recorder={DOCKED} />, "web"),
  screen("after-stop", () => (
    <Home recorder={IDLE} toast="Saved to your space" />
  )),
  {
    ...screen("issues", () => <Home recorder={ISSUES} />),
    scrollTo: '[data-testid="capture-issue-dismiss"]',
  },
  screen("empty", () => <Home recorder={IDLE} rows={[]} />),
];
