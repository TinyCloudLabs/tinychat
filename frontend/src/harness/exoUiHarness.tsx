// Entry of the exo-ui screenshot harness (test/exo-ui-screens.e2e.test.ts):
// renders one registered screen with real components.
//
//   ?screen=<id>&theme=light|dark&platform=ios|android|tauri|web&freeze=1
//
// Without ?screen it lists the registry (and sets window.exoUi.screens).
// Screens live in screens/<group>.tsx, one file per group.
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { initSizeClass } from "@/lib/sizeClass";
import { applyTheme } from "@/lib/theme";
import type { HarnessScreen } from "./screen";
import { legacyScreens } from "./screens/legacy";
import { primitivesScreens } from "./screens/primitives";
import { freezeClock } from "./stubs";

type ScreenInfo = Omit<HarnessScreen, "render">;

declare global {
  interface Window {
    exoUi?: { screens: ScreenInfo[]; ready: boolean };
  }
}

const SCREENS: HarnessScreen[] = [...primitivesScreens, ...legacyScreens];
const PLATFORMS: readonly AppPlatform[] = ["ios", "android", "tauri", "web"];

const params = new URLSearchParams(window.location.search);
const platform = PLATFORMS.find((p) => p === params.get("platform")) ?? "web";
if (params.get("freeze") === "1") freezeClock();
applyTheme(params.get("theme") === "dark" ? "dark" : "light", false);
document.documentElement.dataset.platform = platform;
initSizeClass();

window.exoUi = {
  screens: SCREENS.map(({ render: _render, ...info }) => info),
  ready: false,
};

/**
 * Marks the capture ready once the screen has mounted, the fonts are in and a
 * frame has painted, after scrolling the screen's `scrollTo` into view.
 */
function Ready(props: { scrollTo?: string }) {
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
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
  }, [props.scrollTo]);
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
            <a className="text-primary underline underline-offset-4" href={`?screen=${screen.id}&theme=light`}>Day</a>
            <a className="text-primary underline underline-offset-4" href={`?screen=${screen.id}&theme=dark`}>Night</a>
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
        <Ready scrollTo={screen?.scrollTo} />
      </MemoryRouter>
    </PlatformContext.Provider>
  </StrictMode>,
);
