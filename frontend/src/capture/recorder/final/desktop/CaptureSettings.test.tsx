import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LOCAL_WHISPER_MODELS } from "@/lib/localTranscriber";
import type { WhisperModelInfo } from "@/lib/voiceNotes/desktopCaptureExtras";
import { SYSTEM_AUDIO_NOTICE_TEXT } from "./systemAudioNotice";
import { CaptureSettings, SettingsPanel, type SettingsPanelProps } from "./CaptureSettings";

const models = (downloaded: string[], selected: string | null): WhisperModelInfo[] =>
  LOCAL_WHISPER_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    sizeBytes: m.approxSizeMb * 1_000_000,
    downloaded: downloaded.includes(m.id),
    selected: m.id === selected,
    downloading: false,
    progress: null,
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
  systemAudioNotice: false,
  onDismissSystemAudioNotice: () => {},
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

  test("only models on disk are radios; the rest sit outside the radiogroup in a labelled group, each with Get", () => {
    const out = html({
      load: {
        status: "ready",
        data: {
          models: models(["QuantizedTinyEn", "QuantizedBaseEn"], "QuantizedBaseEn"),
          selected: "QuantizedBaseEn",
          systemAudio: false,
          autoSave: false,
        },
      },
    });
    const group = out.slice(out.indexOf('role="radiogroup"'), out.indexOf('role="group"'));
    expect((group.match(/role="radio"/g) ?? []).length).toBe(2);
    expect(group).not.toContain("cs-get");
    expect(group).not.toContain("Whisper Small");
    const rest = out.slice(out.indexOf('role="group"'));
    expect(rest).toContain('aria-label="Available to download"');
    expect(rest).not.toContain('role="radio"');
    expect((rest.match(/class="cs-get"/g) ?? []).length).toBe(5);
    expect(rest).toContain("Whisper Large Turbo");
    expect(rest).toContain("874 MB");
    expect(out).not.toContain("aria-disabled");
  });

  test("with a model on disk but none selected, the first radio is the tab stop", () => {
    const out = html({
      load: {
        status: "ready",
        data: {
          models: models(["QuantizedBaseEn", "QuantizedSmall"], null),
          selected: null,
          systemAudio: false,
          autoSave: false,
        },
      },
    });
    expect((out.match(/role="radio"[^>]*tabindex="0"/g) ?? []).length).toBe(1);
    expect(out).toMatch(/role="radio" aria-checked="false" tabindex="0"[^>]*>.*?Whisper Base \(English\)/);
  });

  test("with nothing on disk there is no radio, no tab stop, and one line saying so; every model has Get", () => {
    const out = html({
      load: {
        status: "ready",
        data: { models: models([], null), selected: null, systemAudio: false, autoSave: false },
      },
    });
    expect(out).toContain("No model on this Mac yet. Get one below.");
    expect(out).not.toContain('role="radio"');
    expect(out).not.toContain('role="radiogroup"');
    expect((out.match(/class="cs-get"/g) ?? []).length).toBe(7);
  });

  test("a downloading row is a focusable progressbar with a label and spoken value text", () => {
    const out = html({ downloads: { QuantizedSmall: { status: "downloading", fraction: 0.4 } } });
    expect(out).toMatch(
      /role="progressbar" tabindex="0" aria-label="Whisper Small \(multilingual\) download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40" aria-valuetext="Downloading, 40%"/,
    );
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

describe("system audio notice", () => {
  const data = (systemAudio: boolean) => ({
    ...(APP.load.status === "ready" ? APP.load.data : (undefined as never)),
    systemAudio,
  });
  const shown = (out: string) => out.includes(SYSTEM_AUDIO_NOTICE_TEXT);

  test("shows under the switch while system audio is on, with a named Dismiss button", () => {
    const out = html({ systemAudioNotice: true });
    expect(shown(out)).toBe(true);
    expect(out.indexOf("switch-system-audio")).toBeLessThan(out.indexOf(SYSTEM_AUDIO_NOTICE_TEXT));
    expect(out.indexOf(SYSTEM_AUDIO_NOTICE_TEXT)).toBeLessThan(out.indexOf("Save to your space automatically"));
    expect(out).toMatch(/<button type="button" class="cs-notice-dismiss" aria-label="Dismiss the system audio notice"/);
  });

  test("is hidden once seen", () => {
    expect(shown(html({ systemAudioNotice: false }))).toBe(false);
  });

  test("is hidden while system audio is off", () => {
    expect(
      shown(html({ systemAudioNotice: true, load: { status: "ready", data: data(false) } })),
    ).toBe(false);
  });

  test("is hidden on web and on the phone, where the panel has no system audio switch", () => {
    expect(
      shown(html({ variant: "microphone-only", extrasAvailable: false, systemAudioNotice: true })),
    ).toBe(false);
    expect(
      shown(renderToStaticMarkup(<CaptureSettings variant="microphone-only" inputs={null} defaultOpen />)),
    ).toBe(false);
  });

  test("a build with no desktop extras never reads or shows it", () => {
    const storage = {
      getItem: () => {
        throw new Error("read");
      },
      setItem: () => {},
    };
    const out = renderToStaticMarkup(
      <CaptureSettings variant="app" inputs={null} extras={null} defaultOpen noticeStorage={storage} />,
    );
    expect(shown(out)).toBe(false);
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

  test("the open popover has a polite live region for announcements", () => {
    const open = renderToStaticMarkup(<CaptureSettings variant="microphone-only" inputs={null} defaultOpen />);
    expect(open).toMatch(/role="status" aria-live="polite"/);
  });

  test("the app variant with no registered extras shows the unavailable state", () => {
    const open = renderToStaticMarkup(<CaptureSettings variant="app" inputs={null} extras={null} defaultOpen />);
    expect(open).toContain("Capture settings aren’t available in this build.");
  });
});
