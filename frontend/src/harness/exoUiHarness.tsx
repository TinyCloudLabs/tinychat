// Entry of the exo-ui screenshot harness (test/exo-ui-screens.e2e.test.ts):
// renders one registered screen with real components.
//
//   ?screen=<id>&theme=light|dark&platform=ios|android|tauri|web&freeze=1
//
// An ios or android platform installs the fake voice-notes plugin, so the
// phone app's recorder views render.
//
// Without ?screen it lists the registry (and sets window.exoUi.screens).
// Screens live in screens/<group>.tsx, one file per group.
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { __setBuildInfoForTests } from "@/lib/buildInfo";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { initSizeClass } from "@/lib/sizeClass";
import { applyTheme } from "@/lib/theme";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { createFakeVoiceNotes as createCaptureFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import type { HarnessScreen } from "./screen";
import { captureScreens } from "./screens/capture";
import { legacyScreens } from "./screens/legacy";
import { libraryScreens } from "./screens/library";
import { primitivesScreens } from "./screens/primitives";
import { recorderScreens } from "./screens/recorder";
import { sheetsScreens } from "./screens/sheets";
import { shellScreens } from "./screens/shell";
import { FROZEN_NOW, freezeClock } from "./stubs";

type ScreenInfo = Omit<HarnessScreen, "render">;

declare global {
  interface Window {
    exoUi?: { screens: ScreenInfo[]; ready: boolean };
  }
}

const SCREENS: HarnessScreen[] = [
  ...primitivesScreens,
  ...legacyScreens,
  ...shellScreens,
  ...sheetsScreens,
  ...recorderScreens,
  ...captureScreens,
  ...libraryScreens,
];
const PLATFORMS: readonly AppPlatform[] = ["ios", "android", "tauri", "web"];

// Hermetic: nothing leaves the machine. A call to another host (the model's
// attestation check) fails at once, as it would offline, and the screen shows
// its failed state instead of depending on the network.
const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(href, window.location.href).origin !== window.location.origin) {
    return Promise.reject(new TypeError("Failed to fetch"));
  }
  return realFetch(input, init);
};

const params = new URLSearchParams(window.location.search);
const platform = PLATFORMS.find((p) => p === params.get("platform")) ?? "web";
if (params.get("freeze") === "1") freezeClock();
applyTheme(params.get("theme") === "dark" ? "dark" : "light", false);
document.documentElement.dataset.platform = platform;
initSizeClass();
// The phone app records through its native plugin; here a fake stands in. A
// fake App.getInfo() makes the build line resolve with the real native
// segments (build number and bundle id), not just the web baseline (TC-840).
if (platform === "ios" || platform === "android") {
  __setBuildInfoForTests({ version: "", build: "160", id: "xyz.tinycloud.exo.dev" });
  const fake = createCaptureFakeVoiceNotes();
  if (params.get("screen")?.startsWith("recorder-")) {
    fake.controls.commitLegacy({
      id: "rec-1", startedAt: FROZEN_NOW - 42_000, durationMs: 42_000,
      mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    });
  }
  __setVoiceNotesForTests(fake.plugin, { available: true });
}

window.exoUi = {
  screens: SCREENS.map(({ render: _render, ...info }) => info),
  ready: false,
};

/**
 * Marks the capture ready once the screen has mounted, the fonts are in and a
 * frame has painted, after scrolling the screen's `scrollTo` into view.
 */
function Ready(props: { scrollTo?: string; readyWhen?: string }) {
  useEffect(() => {
    let cancelled = false;
    const until = Date.now() + 5_000;
    const arrived = () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (cancelled || !props.readyWhen || document.querySelector(props.readyWhen) || Date.now() > until) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
    void Promise.all([document.fonts.ready, arrived()]).then(() => {
      if (props.scrollTo) document.querySelector(props.scrollTo)?.scrollIntoView({ block: "center" });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled && window.exoUi) window.exoUi.ready = true;
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [props.scrollTo, props.readyWhen]);
  return null;
}

function Index() {
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="font-display text-title-1">Exo UI screens</h1>
      <ul className="mt-4 flex flex-col gap-2 text-body">
        {SCREENS.map((screen) => (
          <li key={screen.id} className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate">{screen.id}</span>
            <a className="text-primary underline underline-offset-4" href={`?screen=${screen.id}&theme=light&platform=${screen.platform ?? "web"}`}>Day</a>
            <a className="text-primary underline underline-offset-4" href={`?screen=${screen.id}&theme=dark&platform=${screen.platform ?? "web"}`}>Night</a>
          </li>
        ))}
      </ul>
    </main>
  );
}

const screenId = params.get("screen");
const screen = SCREENS.find((s) => s.id === screenId);
if (screenId && !screen) throw new Error(`exo-ui harness: no screen "${screenId}"`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlatformContext.Provider value={platform}>
      <MemoryRouter initialEntries={[screen?.path ?? "/"]}>
        {screen ? screen.render() : <Index />}
        <Ready scrollTo={screen?.scrollTo} readyWhen={screen?.readyWhen} />
      </MemoryRouter>
    </PlatformContext.Provider>
  </StrictMode>,
);
