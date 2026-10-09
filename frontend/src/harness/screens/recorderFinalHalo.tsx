import { useEffect, useState } from "react";
import {
  HaloRing,
  LevelBars,
  MirroredSpectrumBars,
  sourceFromLevel,
} from "@/capture/recorder/final/halo";
import type { HarnessScreen } from "../screen";

const LEVEL_SCRIPT = [0.16, 0.35, 0.35] as const;
const SCRIPT_SOURCES = [
  sourceFromLevel(LEVEL_SCRIPT[0], 0.22, 0.42),
  sourceFromLevel(LEVEL_SCRIPT[1], 0.42, 0.74),
  sourceFromLevel(LEVEL_SCRIPT[2], 0.42, 0.91),
];
const ACTIVE = SCRIPT_SOURCES[SCRIPT_SOURCES.length - 1];

function subscribeScript(listener: (source: typeof ACTIVE) => void) {
  for (const source of SCRIPT_SOURCES) listener(source);
  return () => {};
}

function subscribeLevels(listener: (level: number) => void) {
  for (const level of LEVEL_SCRIPT) listener(level);
  return () => {};
}

declare global {
  interface Window {
    haloStall?: { done: boolean };
  }
}

// Test-only (?haloStall=<ms>): blocks the main thread in each of the first
// three animation frames, so rings are flushed and then starved the way a slow
// first load starves them. Without the param the harness is unchanged.
function HaloStall() {
  useEffect(() => {
    const ms = Number(new URLSearchParams(window.location.search).get("haloStall"));
    if (!(ms > 0)) return;
    const state = { done: false };
    window.haloStall = state;
    let frames = 0;
    let handle = 0;
    const frame = () => {
      const until = performance.now() + ms;
      while (performance.now() < until);
      if (++frames < 3) handle = requestAnimationFrame(frame);
      else state.done = true;
    };
    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, []);
  return null;
}

function IdleRing({ theme }: { theme: "night" | "day" }) {
  const [surface, setSurface] = useState(theme);
  return (
    <div style={{ textAlign: "center", padding: "44px 40px 58px" }}>
      <button
        type="button"
        data-halo-theme-toggle=""
        onClick={() =>
          setSurface((current) => (current === "night" ? "day" : "night"))
        }
        style={{
          display: "block",
          minHeight: 44,
          margin: "0 auto 54px",
          padding: "10px 14px",
          border: "1px solid currentColor",
          borderRadius: 999,
          color: "inherit",
          background: "transparent",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        Switch idle disc theme
      </button>
      <HaloRing size={118} ticks={40} theme={surface} />
      <p>Idle · theme refresh</p>
    </div>
  );
}

function ThemePreview({ theme }: { theme: "night" | "day" }) {
  const night = theme === "night";
  return (
    <section
      style={{
        background: night ? "#17111f" : "#fbf5ee",
        color: night ? "#f6effa" : "#3a2f36",
        borderRadius: 16,
        padding: 20,
      }}
    >
      <h2 style={{ fontSize: 17, fontWeight: 600, margin: "0 0 14px" }}>
        {night ? "Night" : "Day"}
      </h2>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-around",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ textAlign: "center", padding: "44px 40px 58px" }}>
          <HaloRing
            size={172}
            ticks={44}
            theme={theme}
            source={ACTIVE}
            subscribe={subscribeScript}
          />
          <p style={{ margin: "54px 0 0" }}>Recording · phone</p>
        </div>
        <div style={{ textAlign: "center", padding: "44px 40px 58px" }}>
          <HaloRing
            size={172}
            ticks={44}
            theme={theme}
            paused
            source={ACTIVE}
            subscribe={subscribeScript}
          />
          <p style={{ margin: "54px 0 0" }}>Paused</p>
        </div>
        <div style={{ textAlign: "center", padding: "44px 40px 58px" }}>
          <HaloRing
            size={214}
            ticks={44}
            theme={theme}
            source={ACTIVE}
            subscribe={subscribeScript}
          />
          <p style={{ margin: "54px 0 0" }}>Recording · desktop</p>
        </div>
        <div style={{ textAlign: "center", padding: "44px 40px 58px" }}>
          <IdleRing theme={theme} />
        </div>
      </div>
      <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
        <div>
          <LevelBars bars={3} theme={theme} subscribe={subscribeLevels} />
          <span>Via · 3 levels</span>
        </div>
        <div>
          <MirroredSpectrumBars
            bars={30}
            theme={theme}
            source={ACTIVE}
            subscribe={subscribeScript}
          />
          <span>Ribbon · 30 spectrum bars</span>
        </div>
        <div>
          <MirroredSpectrumBars
            bars={22}
            theme={theme}
            source={ACTIVE}
            subscribe={subscribeScript}
          />
          <span>Dock · 22 spectrum bars</span>
        </div>
        <div>
          <LevelBars
            bars={5}
            theme={theme}
            levels={[0.18, 0.32, 0.52, 0.32, 0.18]}
          />
          <span>Note view · 5 bars</span>
        </div>
      </div>
    </section>
  );
}

export const recorderFinalHaloScreen: HarnessScreen = {
  id: "recorder-final-halo",
  group: "recorder",
  layout: "document",
  displayTitle: false,
  render: () => {
    const previews = document.documentElement.classList.contains("dark")
      ? (["night", "day"] as const)
      : (["day", "night"] as const);
    return (
      <main
        style={{
          display: "grid",
          gridTemplateColumns: window.innerWidth >= 1200 ? "1fr 1fr" : "1fr",
          gap: 20,
          padding: 20,
          overflowX: "clip",
          background: "#100d14",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <p
          style={{
            gridColumn: "1 / -1",
            margin: 0,
            color: "#b9b2be",
            fontSize: 13,
          }}
        >
          Rings draw while in view. Scroll to start rings outside the viewport;
          the halo-review capture keeps all eight in view.
        </p>
        <HaloStall />
        {previews.map((theme) => (
          <ThemePreview key={theme} theme={theme} />
        ))}
      </main>
    );
  },
};
