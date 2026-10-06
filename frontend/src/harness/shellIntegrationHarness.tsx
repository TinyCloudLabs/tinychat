// Browser harness for test/shell-invariants.e2e.test.ts (TC-761): the real
// AppShell with the real surfaces (ShellApp.tsx), as the Android app, under
// StrictMode as main.tsx renders it. Each surface sits in a MountProbe, the
// native recorder is the fake plugin (it counts listeners), and the chat runs
// on the in-memory runtime shim against the test server's held stream.
// window.shellHarness drives it: navigate, Android Back, the auth state.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";

import type { AppState } from "@/lib/appState";
import { initSizeClass } from "@/lib/sizeClass";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { screenFor } from "@/shell/routes";
import { useBack } from "@/shell/useAndroidBack";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
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
      voiceNotes: () => { adds: number; active: number; recording: boolean };
      emitLevel: (level: number) => void;
    };
  }
}

initSizeClass();
const fake = createFakeVoiceNotes();
__setVoiceNotesForTests(fake.plugin, { available: true });
const shim = createRuntimeShim();
let minimized = 0;

function Controls({ onState }: { onState: (state: AppState) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const back = useBack({
    screen: screenFor(location.pathname),
    platform: "android",
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
    <>
      <ShellApp
        platform="android"
        shim={shim}
        state={state}
        probe={(id, node) => <MountProbe id={id}>{node}</MountProbe>}
      />
      <Controls onState={setState} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Harness />
    </BrowserRouter>
  </StrictMode>,
);
