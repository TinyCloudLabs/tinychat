// The desktop ⚙︎ Capture settings popover (D4) over a scripted DesktopCaptureExtras, in the Capture header's
// place: the app variant (nothing downloaded, one downloading, Large Turbo selected, a failed download,
// nothing registered) and the web variant. The interactive screen exposes `window.exoCaptureSettings` for
// test/capture-settings.e2e.test.ts to drive the downloads and make calls fail.
import { useState, type ReactNode } from "react";
import {
  CaptureSettings,
  type CaptureSettingsVariant,
} from "@/capture/recorder/final/desktop/CaptureSettings";
import type { Downloads } from "@/capture/recorder/final/desktop/captureSettingsModel";
import type { AudioInputsSource } from "@/capture/recorder/final/useAudioInputs";
import { useResolvedTheme } from "@/lib/theme";
import type { WhisperModelId } from "@/lib/voiceNotes/desktopCaptureExtras";
import {
  createFakeDesktopCaptureExtras,
  type FakeCall,
  type FakeDesktopCaptureExtrasOptions,
} from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import type { HarnessScreen } from "../screen";

declare global {
  interface Window {
    exoCaptureSettings?: {
      calls: string[];
      emitProgress: (id: WhisperModelId, fraction: number) => void;
      finishDownload: (id: WhisperModelId) => void;
      failDownload: (id: WhisperModelId, message: string) => void;
      failNext: (call: FakeCall, message: string) => void;
    };
  }
}

const noop = () => {};

const MICROPHONE: AudioInputsSource = {
  list: async () => ({
    inputs: [{ id: "mac", name: "MacBook Pro Microphone", kind: "built_in" }],
    selectedId: "mac",
    activeId: "mac",
  }),
  select: async () => {},
  subscribe: () => noop,
};

function Frame({ children }: { children: ReactNode }) {
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  return (
    <div
      className={`soft-skin soft-${theme}`}
      data-layout="desktop"
      style={{ position: "fixed", inset: 0, overflow: "hidden" }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "24px 24px 0",
          maxWidth: 1200,
          margin: "0 auto",
        }}
      >
        <h1
          style={{
            flex: 1,
            margin: 0,
            fontFamily: "var(--soft-title-font)",
            fontVariationSettings: '"SOFT" 100',
            fontWeight: 400,
            fontSize: 40,
            lineHeight: 1,
          }}
        >
          Capture
        </h1>
        {children}
      </header>
    </div>
  );
}

function Settings({
  variant,
  fake,
  noExtras = false,
  initialDownloads,
  interactive = false,
}: {
  variant: CaptureSettingsVariant;
  fake?: FakeDesktopCaptureExtrasOptions;
  noExtras?: boolean;
  initialDownloads?: Downloads;
  interactive?: boolean;
}) {
  const [scripted] = useState(() => {
    const created = createFakeDesktopCaptureExtras(fake);
    if (interactive)
      window.exoCaptureSettings = {
        calls: created.calls,
        emitProgress: created.emitProgress,
        finishDownload: created.finishDownload,
        failDownload: created.failDownload,
        failNext: created.failNext,
      };
    return created;
  });
  return (
    <Frame>
      <span style={{ fontWeight: 600, fontSize: 14, color: "var(--dim)" }}>
        Library
      </span>
      <CaptureSettings
        variant={variant}
        inputs={MICROPHONE}
        extras={noExtras ? null : scripted.extras}
        defaultOpen={!interactive}
        initialDownloads={initialDownloads}
      />
    </Frame>
  );
}

const LARGE_TURBO: FakeDesktopCaptureExtrasOptions = {
  downloaded: ["QuantizedLargeTurbo"],
  selected: "QuantizedLargeTurbo",
  systemAudio: true,
  autoSaveToSpace: true,
};

function screen(
  name: string,
  render: () => ReactNode,
  options: { interactive?: boolean; readyWhen?: string } = {},
): HarnessScreen {
  return {
    id: `capture-settings-${name}`,
    group: "recorder",
    layout: "pane",
    displayTitle: false,
    readyWhen: ".cs-row[data-testid=settings-mic]",
    ...options,
    render,
  };
}

export const captureSettingsScreens: HarnessScreen[] = [
  screen("app-none", () => (
    <Settings
      variant="app"
      fake={{ downloaded: [], selected: null, autoSaveToSpace: true }}
    />
  )),
  screen("app-downloading", () => (
    <Settings
      variant="app"
      fake={{ downloaded: ["QuantizedTinyEn"], selected: "QuantizedTinyEn" }}
      initialDownloads={{
        QuantizedSmall: { status: "downloading", fraction: 0.4 },
      }}
    />
  )),
  screen("app-selected", () => <Settings variant="app" fake={LARGE_TURBO} />),
  screen("app-error", () => (
    <Settings
      variant="app"
      fake={LARGE_TURBO}
      initialDownloads={{
        QuantizedSmall: { status: "error", message: "The network dropped" },
      }}
    />
  )),
  screen("app-unavailable", () => <Settings variant="app" noExtras />, {
    readyWhen: "[data-testid=settings-unavailable]",
  }),
  screen("web", () => <Settings variant="microphone-only" />),
  screen(
    "interactive",
    () => (
      <Settings
        variant="app"
        interactive
        fake={{ downloaded: ["QuantizedTinyEn"], selected: "QuantizedTinyEn" }}
      />
    ),
    { interactive: true, readyWhen: "[data-testid=capture-settings-button]" },
  ),
];
