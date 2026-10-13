// Browser harness for test/shell-invariants.e2e.test.ts (TC-761): the real
// AppShell with the real surfaces (ShellApp.tsx), as the Android app (or a browser with ?platform=web), under
// StrictMode as main.tsx renders it. Each surface sits in a MountProbe, the
// native recorder is the fake plugin (it counts listeners), and the chat runs
// on the in-memory runtime shim against the test server's held stream.
// window.shellHarness drives it: navigate, Android Back, the auth state.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";

import type { AppState } from "@/lib/appState";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { initSizeClass } from "@/lib/sizeClass";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __setOnDeviceSttForTests } from "@/lib/voiceNotes/onDeviceStt";
import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { screenFor } from "@/shell/routes";
import { useBack } from "@/shell/useAndroidBack";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { libraryTcw } from "./fixtures/library";
import { MountProbe } from "./MountProbe";
import { createRuntimeShim } from "./runtimeShim";
import { ShellApp } from "./ShellApp";

declare global {
  interface Window {
    shellHarness?: {
      navigate: (path: string) => void;
      /** Android's hardware Back, exactly as the app carries it out. */
      back: () => void;
      setState: (state: AppState) => void;
      /** Times Back minimised the app (at home). */
      minimized: () => number;
      voiceNotes: () => { adds: number; active: number; recording: boolean; deleted: string[] };
      emitLevel: (level: number) => void;
    };
  }
}

initSizeClass();
const params = new URLSearchParams(window.location.search);
// ?nativeReadDelayMs=2500 on the page URL delays listPending/localAudioUrl that long, for tests
// of the receipt's display-clock gating (TC-781) that an instant fake can't establish the timing
// of. ?unownedNotes=1 reports every committed note as unowned, regardless of the harness's always
// signed-in account (RecorderProvider here uses harnessTcw, not captureTcw below, and
// harnessTcw's SQL stub can never satisfy the voice-note-identity schema check those tests would
// otherwise race against): native holds an unowned note rather than attempting to save it, so
// outcome stays "local" long enough to actually observe the display clock.
// ?platform=web runs the same shell as a browser; the default is the Android app.
const platform: AppPlatform = params.get("platform") === "web" ? "web" : "android";
const nativeReadDelayMs = Number(params.get("nativeReadDelayMs") ?? 0) || 0;
const unownedNotes = params.get("unownedNotes") === "1";
const fake = createFakeVoiceNotes({ nativeReadDelayMs, unownedNotes });
__setVoiceNotesForTests(fake.plugin, { available: platform !== "web" });
__setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
const shim = createRuntimeShim();
// Capture reads a space with captures in it, so a note can be opened.
const captureTcw = libraryTcw();
let minimized = 0;

function Controls({ onState }: { onState: (state: AppState) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const back = useBack({
    screen: screenFor(location.pathname),
    platform,
    onMinimize: () => {
      minimized += 1;
    },
  });
  useEffect(() => {
    window.shellHarness = {
      navigate: (path) => navigate(path),
      back,
      setState: onState,
      minimized: () => minimized,
      voiceNotes: () => fake.stats(),
      emitLevel: (level) => fake.emit("level", { level }),
    };
  }, [navigate, back, onState]);
  return null;
}

function Harness() {
  const [state, setState] = useState<AppState>("ready");
  return (
    <PlatformContext.Provider value={platform}>
      <ShellApp
        platform={platform}
        shim={shim}
        state={state}
        captureTcw={captureTcw}
        probe={(id, node) => <MountProbe id={id}>{node}</MountProbe>}
      />
      <Controls onState={setState} />
    </PlatformContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Harness />
    </BrowserRouter>
  </StrictMode>,
);
