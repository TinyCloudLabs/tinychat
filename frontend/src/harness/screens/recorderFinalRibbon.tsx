// The minimised final recorder (TC-870) in the app shell: the Ribbon above the tab bar on a phone, the
// floating Ribbon on the rail, the dock in the sidebar. The viewport picks which. Each screen runs over
// a recorder that remembers what it is asked to do: the page exposes `window.exoMinimized` (the calls in
// order, and a patch for the recorder's state) for test/recorder-final-ribbon.e2e.test.ts to drive.
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  useRecorder,
  type RecorderValue,
} from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import {
  __setVoiceNotesForTests,
  type VoiceNotesPlugin,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";

declare global {
  interface Window {
    exoMinimized?: {
      calls: string[];
      patch: (patch: Partial<RecorderValue>) => void;
    };
    /** The real recorder over the fake native plugin: the control calls in order, and the ones that reject while flagged. */
    exoMinimizedNative?: {
      calls: string[];
      fail: Record<"pause" | "resume" | "stop" | "status", boolean>;
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
    elapsedAt: Date.now(),
    sheetOpen: false,
  });
  const log = useMemo(
    () => (window.exoMinimized ??= { calls: [], patch: () => {} }),
    [],
  );
  log.patch = (patch) => setState((current) => ({ ...current, ...patch }));

  // The native recorder reports recorded time at each pause and resume, and the view ticks from the time it
  // received that report (`elapsedAt`); a pause freezes the time there.
  const checkpoint = (mic: RecorderValue["mic"]) =>
    setState((current) => {
      const now = Date.now();
      const running = current.mic?.state !== "paused";
      const elapsed =
        (current.elapsedMs ?? 0) +
        (running ? now - (current.elapsedAt ?? now) : 0);
      return { ...current, mic, elapsedMs: elapsed, elapsedAt: now };
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
    />
  );
}

function screen(name: string, setup: Setup): HarnessScreen {
  return {
    id: `recorder-final-minimized-${name}`,
    group: "recorder",
    layout: "pane",
    displayTitle: false,
    path: "/chat/capture",
    platform: "ios",
    render: () => <Minimized {...setup} />,
  };
}

// The real provider and controller on the fake native plugin, whose Pause, Resume and Stop reject while
// window.exoMinimizedNative.fail says so (and status, which a failed Stop asks to learn whether it stopped):
// the errors reach the Ribbon as they do on a phone.
function installNativePlugin() {
  const native = (window.exoMinimizedNative ??= {
    calls: [],
    fail: { pause: false, resume: false, stop: false, status: false },
  });
  const fake = createFakeVoiceNotes();
  const plugin: VoiceNotesPlugin = { ...fake.plugin };
  for (const name of ["pause", "resume", "stop", "status"] as const) {
    const call = fake.plugin[name].bind(fake.plugin) as () => Promise<unknown>;
    (plugin as unknown as Record<string, () => Promise<unknown>>)[name] =
      async () => {
        if (name !== "status") native.calls.push(name);
        if (native.fail[name]) {
          throw Object.assign(new Error(`${name} was refused`), {
            code: `${name}_refused`,
          });
        }
        return call();
      };
  }
  __setVoiceNotesForTests(plugin, { available: true });
}

// Starts a recording once the provider is ready, then closes the sheet: the Ribbon or dock takes over.
function StartMinimized() {
  const recorder = useRecorder();
  const started = useRef(false);
  const minimised = useRef(false);
  useEffect(() => {
    if (!started.current) {
      if (!recorder.ready || recorder.phase !== "idle") return;
      started.current = true;
      recorder.record();
    } else if (!minimised.current && recorder.phase === "recording") {
      minimised.current = true;
      void recorder.minimiseSheet();
    }
  }, [recorder]);
  return null;
}

function Native() {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  return (
    <ShellApp
      platform={platform}
      shim={shim}
      state="ready"
      inside={<StartMinimized />}
    />
  );
}

const nativeScreen: HarnessScreen = {
  id: "recorder-final-minimized-native",
  group: "recorder",
  layout: "pane",
  displayTitle: false,
  path: "/chat/capture",
  platform: "ios",
  interactive: true,
  render: () => {
    installNativePlugin();
    return <Native />;
  },
};

export const recorderFinalRibbonScreens: HarnessScreen[] = [
  nativeScreen,
  screen("recording", { paused: false, elapsedMs: 6000 }),
  screen("paused", { paused: true, elapsedMs: 15000 }),
  screen("silenced", {
    paused: false,
    mic: { state: "silenced", reason: "os_silenced" },
    elapsedMs: 15000,
  }),
  screen("interrupted", {
    paused: false,
    mic: { state: "interrupted", reason: "call" },
    elapsedMs: 15000,
  }),
];
