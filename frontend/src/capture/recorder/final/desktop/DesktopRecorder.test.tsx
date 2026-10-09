import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext } from "@/lib/platform";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests } from "@/lib/voiceNotes/captureEngine";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../../RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "../../transcriptionProps";
import { DesktopRecorder, DesktopRecorderSeedContext, type DesktopRecorderProps } from "./DesktopRecorder";

const noop = () => {};
const PRIVATE_ON: VoiceNoteTranscriptionProps = {
  availability: "available",
  consented: true,
  maxSeconds: 600,
  jobs: new Map(),
  onTranscribe: noop,
  onConsent: noop,
  onTurnOff: noop,
  onRecheck: noop,
};

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 1,
  audioMs: 768_000,
  elapsedMs: 768_000,
  transcription: PRIVATE_ON,
  transcriber: {
    id: "private-cloud",
    identifySpeakers: false,
    source: "recording",
  },
  sheetOpen: true,
};

const render = (
  patch: Partial<RecorderValue> = {},
  props: Partial<DesktopRecorderProps> = {},
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value="tauri">
        <StaticRecorderProvider value={{ ...LIVE, ...patch }}>
          <DesktopRecorder layout="desktop" {...props} />
        </StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>,
  );

const withNotes = { onOpenNotes: () => {} };

const MAC_CAPABILITIES = {
  nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
  background: true, localTranscription: false, desktopWhisper: true, offlineRecorder: true,
};

describe("DesktopRecorder", () => {
  afterEach(() => __resetCaptureEngineForTests());

  test("recording shows the timer, the pause ring and the three controls", () => {
    const html = render();
    expect(html).toContain("12:48");
    expect(html).toContain('aria-label="Pause recording"');
    expect(html).toContain('aria-label="Discard recording"');
    expect(html).toContain("Done");
    expect(html).not.toContain("Open Settings");
  });

  test("Write notes becomes View notes once the note has text", () => {
    expect(render({}, withNotes)).toContain("Write notes");
    expect(render({ note: { md: "", moments: [] } }, withNotes)).toContain("Write notes");
    const html = render({ note: { md: "Ask Dana.", moments: [] } }, withNotes);
    expect(html).toContain("View notes");
    expect(html).not.toContain("Write notes");
  });

  test("there is no notes button without a handler", () => {
    const html = render();
    expect(html).not.toContain("Write notes");
    expect(html).not.toContain("View notes");
  });

  test("a revoked permission while recording replaces the controls row with Open Settings", () => {
    const html = render({
      mic: { state: "needs_user", reason: "permission_revoked" },
    });
    expect(html).toContain("Microphone off");
    expect(html).toContain("Open Settings");
    expect(html).not.toContain('aria-label="Discard recording"');
    expect(html).not.toContain('aria-label="Pause recording"');
    expect(html).not.toContain("Done");
    expect(html).toContain('class="pr-src-wrap"');
  });

  test("a denied microphone at idle replaces the controls row with Open Settings", () => {
    const html = render({
      phase: "idle",
      mic: { state: "idle", reason: null },
      permissionDenied: true,
      startedAt: null,
      audioMs: 0,
      elapsedMs: 0,
    });
    expect(html).toContain("Open Settings");
    expect(html).not.toContain('aria-label="Discard recording"');
    expect(html).not.toContain("Done");
    expect(html).not.toContain('class="pr-src-wrap"');
  });

  test("the recording view is a labelled Recorder region", () => {
    const html = render();
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Recorder"');
    expect(html).toContain('class="pr-src-wrap"');
  });

  test("the scale shows the provider's transcriber, not a local stand-in", () => {
    const html = render();
    expect(html).toContain('aria-valuetext="Private"');
    expect(render({
      transcriber: { id: "off", identifySpeakers: false, source: "recording" },
    })).toContain('aria-valuetext="Audio only"');
  });

  test("signed out on the Mac, Audio only is selected and the rest are locked while there is no Whisper model", () => {
    const stops = (patch: Partial<RecorderValue>) =>
      [...render(patch).matchAll(/data-available="(true|false)"/g)].map(
        (m) => m[1],
      );
    const local = {
      id: "on-device" as const,
      identifySpeakers: false,
      source: "default" as const,
    };
    expect(stops({ signedIn: false, transcriber: local })).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    const html = render({ signedIn: false, transcriber: local });
    expect(html).toContain('aria-valuetext="Audio only"');
    expect(html).toContain("Just the recording, kept on this Mac.");
    expect(html).not.toContain("transcribe it");
    // The open modes card says the same, not "Transcribe it later".
    const card = renderToStaticMarkup(
      <MemoryRouter>
        <PlatformContext.Provider value="tauri">
          <StaticRecorderProvider value={{ ...LIVE, signedIn: false, transcriber: local }}>
            <DesktopRecorderSeedContext.Provider value={{ defaultOpen: "modes" }}>
              <DesktopRecorder layout="desktop" />
            </DesktopRecorderSeedContext.Provider>
          </StaticRecorderProvider>
        </PlatformContext.Provider>
      </MemoryRouter>,
    );
    expect(card).toContain('role="radiogroup"');
    expect(card).not.toContain("Transcribe it later");
    expect(stops({ signedIn: true, transcriber: local })).toEqual([
      "true",
      "false",
      "true",
      "false",
    ]);
  });
  test("signed out on the Mac with Whisper ready, Local is selected and available with the Whisper caption", () => {
    __setInstalledEngineForTests("tauri", MAC_CAPABILITIES);
    const local = { id: "on-device" as const, identifySpeakers: false, source: "default" as const };
    const html = render({ signedIn: false, transcriber: local });
    expect(html).toContain('aria-valuetext="Local"');
    expect(html).toContain("Whisper on this Mac, after you stop.");
    expect([...html.matchAll(/data-available="(true|false)"/g)].map((m) => m[1])).toEqual(["false", "true", "false", "false"]);
    expect(html).not.toContain("Just the recording, kept on this Mac.");
  });

  test("signed in on the Mac with Whisper ready, Local and Private are both open", () => {
    __setInstalledEngineForTests("tauri", MAC_CAPABILITIES);
    const local = { id: "on-device" as const, identifySpeakers: false, source: "default" as const };
    const html = render({ signedIn: true, transcriber: local });
    expect(html).toContain('aria-valuetext="Local"');
    expect([...html.matchAll(/data-available="(true|false)"/g)].map((m) => m[1])).toEqual(["true", "true", "true", "false"]);
  });

  test("a failed note save changes the notes button and raises an alert", () => {
    const failed = render({}, { ...withNotes, noteSaveFailed: true });
    expect(failed).toContain("Note not saved");
    expect(failed).toContain('data-failed="true"');
    expect(failed).toContain("tap Done again to finish without it");
    const fine = render({}, withNotes);
    expect(fine).not.toContain("Note not saved");
    expect(fine).not.toContain("data-failed");
  });
});
