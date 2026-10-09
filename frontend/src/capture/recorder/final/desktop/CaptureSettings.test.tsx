import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LOCAL_WHISPER_MODELS } from "@/lib/localTranscriber";
import type { WhisperModelInfo } from "@/lib/voiceNotes/desktopCaptureExtras";
import { CaptureSettings, SettingsPanel, type SettingsPanelProps } from "./CaptureSettings";

const models = (downloaded: string[], selected: string | null): WhisperModelInfo[] =>
  LOCAL_WHISPER_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    sizeBytes: m.approxSizeMb * 1_000_000,
    downloaded: downloaded.includes(m.id),
    selected: m.id === selected,
  }));

const IDLE = { pending: false, error: null };

const APP: SettingsPanelProps = {
  variant: "app",
  extrasAvailable: true,
  load: {
    status: "ready",
    data: {
      models: models(["QuantizedLargeTurbo"], "QuantizedLargeTurbo"),
      selected: "QuantizedLargeTurbo",
      systemAudio: true,
      autoSave: false,
    },
  },
  downloads: {},
  microphone: { name: "MacBook Pro Microphone", unavailable: false, error: null, retry: null },
  modelError: null,
  switches: { systemAudio: IDLE, autoSave: IDLE },
  onRetryLoad: () => {},
  onSelectModel: () => {},
  onGetModel: () => {},
  onToggle: () => {},
};

const html = (props: Partial<SettingsPanelProps>) =>
  renderToStaticMarkup(<SettingsPanel {...APP} {...props} />);

describe("SettingsPanel, app", () => {
  test("lists the models with sizes, Get on those not on disk, and the selected one checked", () => {
    const out = html({});
    expect(out).toContain("Whisper Tiny (English)");
    expect(out).toContain("44 MB");
    expect(out).toContain("874 MB");
    expect((out.match(/class="cs-get"/g) ?? []).length).toBe(6);
    expect(out).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*><\/span><span class="cs-name">Whisper Large Turbo/);
    expect(out).toContain('role="radiogroup"');
  });

  test("only the selected model is a tab stop", () => {
    const out = html({});
    expect((out.match(/role="radio"[^>]*tabindex="0"/g) ?? []).length).toBe(1);
  });

  test("the microphone, the two switches with their copy, and no shortcuts", () => {
    const out = html({});
    expect(out).toContain("MacBook Pro Microphone");
    expect(out).toContain("change with “via”");
    expect(out).toContain("Also record this Mac’s audio");
    expect(out).toContain("Save to your space automatically");
    expect(out).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="switch-system-audio"/);
    expect(out).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="switch-auto-save"/);
    expect(out.toLowerCase()).not.toContain("shortcut");
  });

  test("a download shows its percentage as a progressbar in place of Get", () => {
    const out = html({ downloads: { QuantizedSmall: { status: "downloading", fraction: 0.4 } } });
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="40"');
    expect(out).toContain("40%");
    expect(out).not.toContain('data-testid="get-QuantizedSmall"');
  });

  test("a failed download says so on its row and offers Retry", () => {
    const out = html({ downloads: { QuantizedSmall: { status: "error", message: "Network lost" } } });
    expect(out).toContain("Could not download Whisper Small (multilingual): Network lost");
    expect(out).toContain('aria-label="Retry Whisper Small (multilingual)"');
  });

  test("a failed switch shows its error and keeps its value", () => {
    const out = html({
      switches: { systemAudio: { pending: false, error: "Could not change this setting: no permission" }, autoSave: IDLE },
    });
    expect(out).toContain("Could not change this setting: no permission");
    expect(out).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="switch-system-audio"/);
  });

  test("with nothing registered, it says the settings are not in this build", () => {
    const out = html({ extrasAvailable: false });
    expect(out).toContain("Capture settings aren’t available in this build.");
    expect(out).not.toContain('role="switch"');
  });

  test("a failed load shows the error with Try again; loading shows a status", () => {
    expect(html({ load: { status: "error", message: "Could not load the capture settings: boom" } })).toContain("Try again");
    expect(html({ load: { status: "loading" } })).toContain("Loading…");
  });

  test("no microphone and no microphone list are different messages", () => {
    expect(html({ microphone: { name: null, unavailable: false, error: null, retry: null } })).toContain("No microphone found.");
    expect(html({ microphone: { name: null, unavailable: true, error: null, retry: null } })).toContain("Microphone choice isn’t available here.");
  });
});

describe("SettingsPanel, web", () => {
  const out = html({ variant: "microphone-only", extrasAvailable: false });
  test("only the microphone, and the line about what needs the app", () => {
    expect(out).toContain("Local transcription, meeting audio and auto-save need the Exo app.");
    expect(out).toContain("MacBook Pro Microphone");
    expect(out).not.toContain("Whisper");
    expect(out).not.toContain('role="switch"');
  });
});

describe("CaptureSettings", () => {
  test("the button is labelled, collapsed, and opens a dialog labelled Capture settings", () => {
    const closed = renderToStaticMarkup(<CaptureSettings variant="microphone-only" inputs={null} />);
    expect(closed).toContain('aria-label="Capture settings"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('role="dialog"');

    const open = renderToStaticMarkup(<CaptureSettings variant="microphone-only" inputs={null} defaultOpen />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toMatch(/role="dialog" aria-labelledby="([^"]+)"/);
    expect(open).toContain(">Capture settings</h2>");
  });

  test("the app variant with no registered extras shows the unavailable state", () => {
    const open = renderToStaticMarkup(<CaptureSettings variant="app" inputs={null} extras={null} defaultOpen />);
    expect(open).toContain("Capture settings aren’t available in this build.");
  });
});
