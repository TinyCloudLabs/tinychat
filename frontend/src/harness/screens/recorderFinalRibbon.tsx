// The minimised final recorder (TC-870) in the app shell: the Ribbon above the tab bar on a phone, the
// floating Ribbon on the rail, the dock in the sidebar. The viewport picks which. Each screen runs over
// a recorder that remembers what it is asked to do: the page exposes `window.exoRecorder` (the calls in
// order, and a patch for the recorder's state) for test/recorder-final-ribbon.e2e.test.ts to drive.
import { useContext, useMemo, useRef, useState } from "react";

import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";

declare global {
  interface Window {
    exoRecorder?: {
      calls: string[];
      patch: (patch: Partial<RecorderValue>) => void;
    };
  }
}

// A steady moderate level, re-sent so the bars stay alive.
const STEADY_LEVEL = 0.15;
const steadyLevel: RecorderValue["subscribeLevel"] = (listener) => {
  listener(STEADY_LEVEL);
  const timer = setInterval(() => listener(STEADY_LEVEL), 100);
  return () => clearInterval(timer);
};

interface Setup {
  paused: boolean;
  mic?: RecorderValue["mic"];
  elapsedMs: number;
}

function Minimized({ paused, mic, elapsedMs }: Setup) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  const checkpointAt = useRef(Date.now());
  const [state, setState] = useState<Partial<RecorderValue>>({
    phase: "recording",
    mic:
      mic ??
      (paused
        ? { state: "paused", reason: "user" }
        : { state: "recording", reason: null }),
    startedAt: Date.now() - elapsedMs,
    audioMs: elapsedMs,
    elapsedMs,
    sheetOpen: false,
  });
  const log = useMemo(
    () => (window.exoRecorder ??= { calls: [], patch: () => {} }),
    [],
  );
  log.patch = (patch) => setState((current) => ({ ...current, ...patch }));

  // The native recorder reports recorded time at each pause and resume; a pause freezes it there.
  const checkpoint = (mic: RecorderValue["mic"]) =>
    setState((current) => {
      const now = Date.now();
      const running = current.mic?.state !== "paused";
      const elapsed =
        (current.elapsedMs ?? 0) + (running ? now - checkpointAt.current : 0);
      checkpointAt.current = now;
      return { ...current, mic, elapsedMs: elapsed };
    });

  const value = useMemo<Partial<RecorderValue>>(
    () => ({
      ...state,
      subscribeLevel: steadyLevel,
      pause: () => {
        log.calls.push("pause");
        checkpoint({ state: "paused", reason: "user" });
      },
      resume: () => {
        log.calls.push("resume");
        checkpoint({ state: "recording", reason: null });
      },
      stop: () => void log.calls.push("stop"),
      openSheet: () => {
        log.calls.push("openSheet");
        setState((current) => ({ ...current, sheetOpen: true }));
      },
      minimiseSheet: async () => {
        log.calls.push("minimise");
        setState((current) => ({ ...current, sheetOpen: false }));
      },
    }),
    [state],
  );

  return (
    <ShellApp
      platform={platform}
      shim={shim}
      state="ready"
      recorder={value}
      finalRecorder
    />
  );
}

function screen(name: string, setup: Setup): HarnessScreen {
  return {
    id: `recorder-final-minimized-${name}`,
    group: "recorder",
    layout: "pane",
    displayTitle: true,
    path: "/chat/capture",
    platform: "ios",
    render: () => <Minimized {...setup} />,
  };
}

export const recorderFinalRibbonScreens: HarnessScreen[] = [
  screen("recording", { paused: false, elapsedMs: 6000 }),
  screen("paused", { paused: true, elapsedMs: 15000 }),
  screen("interrupted", {
    paused: false,
    mic: { state: "interrupted", reason: "call" },
    elapsedMs: 15000,
  }),
];
