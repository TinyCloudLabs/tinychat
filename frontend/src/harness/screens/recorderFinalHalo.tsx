import {
  HaloRing,
  LevelBars,
  LevelSourceAdapter,
  MirroredSpectrumBars,
} from "@/capture/recorder/final/halo";
import type { HarnessScreen } from "../screen";

const adapter = new LevelSourceAdapter(863);
adapter.update(0.35, 0.42, 1000);
let ACTIVE = adapter.sample(1016);
for (let frame = 1032; frame <= 1200; frame += 16)
  ACTIVE = adapter.sample(frame);

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
        <div style={{ textAlign: "center" }}>
          <HaloRing size={172} ticks={44} theme={theme} source={ACTIVE} />
          <p>Recording · phone</p>
        </div>
        <div style={{ textAlign: "center" }}>
          <HaloRing
            size={172}
            ticks={44}
            theme={theme}
            paused
            source={ACTIVE}
          />
          <p>Paused</p>
        </div>
        <div style={{ textAlign: "center" }}>
          <HaloRing size={214} ticks={44} theme={theme} source={ACTIVE} />
          <p>Recording · desktop</p>
        </div>
        <div style={{ textAlign: "center" }}>
          <HaloRing size={118} ticks={40} theme={theme} />
          <p>Idle</p>
        </div>
      </div>
      <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
        <div>
          <LevelBars bars={3} theme={theme} levels={[0.28, 0.72, 0.44]} />
          <span>Via · 3 levels</span>
        </div>
        <div>
          <MirroredSpectrumBars bars={30} theme={theme} source={ACTIVE} />
          <span>Ribbon · 30 spectrum bars</span>
        </div>
        <div>
          <MirroredSpectrumBars bars={22} theme={theme} source={ACTIVE} />
          <span>Dock · 22 spectrum bars</span>
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
          gap: 20,
          padding: 20,
          background: "#100d14",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {previews.map((theme) => (
          <ThemePreview key={theme} theme={theme} />
        ))}
      </main>
    );
  },
};
