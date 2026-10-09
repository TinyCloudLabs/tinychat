import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { LocalCaptureHome } from "./LocalCaptureHome";
import { localNoteStatus, LOCAL_ONLY_COPY } from "./localCopy";
import type { VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";

const note = { id: "n", startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
  silencedMs: 0, silencedEvents: 0, noSignalMs: 0 } satisfies VoiceNoteRecording;

test("signed-out capture uses the shared recorder and promises local retention", () => {
  const html = renderToStaticMarkup(<StaticRecorderProvider value={{ signedIn: false }}>
    <LocalCaptureHome onSignIn={() => {}} />
  </StaticRecorderProvider>);
  expect(html).toContain("Sign in to sync");
  expect(html).toContain("Record");
  expect(html).toContain(LOCAL_ONLY_COPY);
});

test("offline capture keeps its retry affordance", () => {
  const html = renderToStaticMarkup(<StaticRecorderProvider><LocalCaptureHome offline /></StaticRecorderProvider>);
  expect(html).toContain("You&#x27;re offline");
  expect(html).toContain("Try again");
});

test("local note status reflects durable transcription and recovery", () => {
  expect(localNoteStatus({ ...note, recovered: true })).toBe("Recovered after Exo closed");
  expect(localNoteStatus({ ...note, stt: { state: "waiting_for_model", pack: null, engine: null,
    segmentsDone: 0, windowsDone: 0, error: null } })).toBe("Waiting for the on-device model");
});
