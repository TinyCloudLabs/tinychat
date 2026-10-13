import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRecorderProvider } from "./recorder/RecorderProvider";
import { DeviceCaptureSurface } from "./DeviceCaptureSurface";
import { screenFor } from "@/shell/routes";
import { installDom } from "@/test/dom";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt, __setOnDeviceSttForTests, type OnDeviceSttPlugin, type OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import { __resetOnDeviceSttStoreForTests, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";

const nativeStt = OnDeviceStt;
beforeAll(() => {
  __setOnDeviceSttForTests({
    status: async () => ({ models: [], pack: "full", autoDownload: false, download: { policy: "system", state: "idle" }, engine: "apple-speech", appleSpeech: "ready", queue: [] }),
    addListener: async () => ({ remove: async () => {} }),
  } as unknown as OnDeviceSttPlugin);
  __resetOnDeviceSttStoreForTests();
});
afterAll(() => { __setOnDeviceSttForTests(nativeStt); __resetOnDeviceSttStoreForTests(); });

function render(offline: boolean): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={["/chat/capture"]}>
    <StaticRecorderProvider value={{ signedIn: false, available: true }}>
      <DeviceCaptureSurface did={null} offline={offline} error={null}
        onSignIn={() => {}} onRetry={() => {}} screen={screenFor("/chat/capture")} />
    </StaticRecorderProvider>
  </MemoryRouter>);
}

test("signed-out capture keeps the shared Capture surface, Library and recorder with a sign-in action", () => {
  const html = render(false);
  expect(html).toContain('data-testid="capture-surface"');
  expect(html).toContain("Library");
  expect(html).toContain("Record");
  expect(html).toContain("Sign in");
});

test("offline capture keeps recording and offers a connection retry", () => {
  const html = render(true);
  expect(html).toContain("Record");
  expect(html).toContain("Try again");
  expect(html).toContain("Recordings stay on this phone");
});

test("ready Apple Speech wakes a signed-out note waiting in the native queue", async () => {
  const restoreDom = installDom();
  const originalStt = OnDeviceStt;
  const fakeNotes = createFakeVoiceNotes();
  const note: VoiceNoteRecording = {
    id: "waiting-note", startedAt: Date.now(), durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
    options: { transcriber: "on-device", identifySpeakers: false },
    stt: { state: "waiting_for_model", pack: null, engine: null, segmentsDone: 0, windowsDone: 0, error: null },
  };
  fakeNotes.controls.commitLegacy(note);
  __setVoiceNotesForTests(fakeNotes.plugin, { available: true });
  const status: OnDeviceSttStatus = {
    models: [], pack: "full", autoDownload: false, download: { policy: "system", state: "idle" },
    engine: "apple-speech", appleSpeech: "ready", queue: [{ id: note.id, state: "waiting_for_model", percent: null, error: null }],
  };
  let wakes = 0;
  __setOnDeviceSttForTests({
    status: async () => status,
    installSpeechAssets: async () => { wakes++; },
    addListener: async () => ({ remove: async () => {} }),
  } as unknown as OnDeviceSttPlugin);
  __resetOnDeviceSttStoreForTests();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await onDeviceSttStore.refresh();
    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/chat/capture"]}>
        <StaticRecorderProvider value={{ signedIn: false, available: true }}>
          <DeviceCaptureSurface did={null} offline={false} error={null} onSignIn={() => {}} onRetry={() => {}} screen={screenFor("/chat/capture")} />
        </StaticRecorderProvider>
      </MemoryRouter>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(wakes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    __setVoiceNotesForTests(null, { available: null });
    __setOnDeviceSttForTests(originalStt);
    __resetOnDeviceSttStoreForTests();
    restoreDom();
  }
});
