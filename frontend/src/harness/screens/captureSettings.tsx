// The desktop ⚙︎ Capture settings popover (D4) over a scripted DesktopCaptureExtras, in the Capture header's
// place: the app variant (nothing downloaded, one downloading, Large Turbo selected, a failed download,
// nothing registered) and the web variant. The interactive screen exposes `window.exoCaptureSettings` for
// test/capture-settings.e2e.test.ts to drive the downloads and make calls fail.
import { useEffect, useState, type ReactNode } from "react";
import {
  CaptureSettings,
  type CaptureSettingsVariant,
} from "@/capture/recorder/final/desktop/CaptureSettings";
import { markSystemAudioNoticeSeen } from "@/capture/recorder/final/desktop/systemAudioNotice";
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
      startExternalDownload: (id: WhisperModelId, fraction?: number | null) => void;
      emitProgress: (id: WhisperModelId, fraction: number) => void;
      finishDownload: (id: WhisperModelId) => void;
      failDownload: (id: WhisperModelId, message: string) => void;
      failNext: (call: FakeCall, message: string) => void;
    };
  }
}

const noop = () => {};

const noticeStorage = (seen: boolean) => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
  if (seen) markSystemAudioNoticeSeen(storage);
  return storage;
};

// The ⚙︎ lives on the desktop Capture header, which the rail (768 and up) and desktop layouts place.
const RAIL_MIN_WIDTH = 768;

const MICROPHONE: AudioInputsSource = {
  list: async () => ({
    inputs: [{ id: "mac", name: "MacBook Pro Microphone", kind: "built_in" }],
    selectedId: "mac",
    activeId: "mac",
  }),
  select: async () => {},
  subscribe: () => noop,
};

function Frame({
  children,
  outsideField = false,
}: {
  children: ReactNode;
  outsideField?: boolean;
}) {
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
        {outsideField && (
          <input
            aria-label="Find a note"
            style={{ font: "inherit", padding: "4px 8px" }}
          />
        )}
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
  showNotice = false,
}: {
  variant: CaptureSettingsVariant;
  fake?: FakeDesktopCaptureExtrasOptions;
  noExtras?: boolean;
  initialDownloads?: Downloads;
  interactive?: boolean;
  showNotice?: boolean;
}) {
  const [storage] = useState(() => noticeStorage(!showNotice));
  const [scripted] = useState(() => createFakeDesktopCaptureExtras(fake));
  useEffect(() => {
    if (!interactive) return;
    window.exoCaptureSettings = {
      calls: scripted.calls,
      startExternalDownload: scripted.startExternalDownload,
      emitProgress: scripted.emitProgress,
      finishDownload: scripted.finishDownload,
      failDownload: scripted.failDownload,
      failNext: scripted.failNext,
    };
  }, [interactive, scripted]);
  return (
    <Frame outsideField={interactive}>
      <span style={{ fontWeight: 600, fontSize: 14, color: "var(--dim)" }}>
        Library
      </span>
      <CaptureSettings
        variant={variant}
        inputs={MICROPHONE}
        extras={noExtras ? null : scripted.extras}
        defaultOpen={!interactive}
        initialDownloads={initialDownloads}
        noticeStorage={storage}
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
    minViewportWidth: RAIL_MIN_WIDTH,
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
      fake={{
        downloaded: ["QuantizedTinyEn"],
        selected: "QuantizedTinyEn",
        downloading: { QuantizedSmall: 0.4 },
      }}
    />
  ), { readyWhen: ".cs-progress" }),
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
  screen(
    "app-system-audio-notice",
    () => <Settings variant="app" fake={LARGE_TURBO} showNotice />,
    { readyWhen: "[data-testid=system-audio-notice]" },
  ),
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
        fake={{
          downloaded: ["QuantizedTinyEn", "QuantizedBaseEn"],
          selected: "QuantizedTinyEn",
        }}
      />
    ),
    { interactive: true, readyWhen: "[data-testid=capture-settings-button]" },
  ),
  screen(
    "interactive-notice",
    () => (
      <Settings
        variant="app"
        interactive
        showNotice
        fake={{ downloaded: ["QuantizedTinyEn"], selected: "QuantizedTinyEn", systemAudio: true }}
      />
    ),
    { interactive: true, readyWhen: "[data-testid=capture-settings-button]" },
  ),
  screen(
    "interactive-none",
    () => (
      <Settings
        variant="app"
        interactive
        fake={{ downloaded: [], selected: null }}
      />
    ),
    { interactive: true, readyWhen: "[data-testid=capture-settings-button]" },
  ),
];
