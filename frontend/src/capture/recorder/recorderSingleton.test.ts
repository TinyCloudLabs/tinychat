// One recorder controller (plan §4.2, §8.3): source guards for what a second
// copy would break. App.tsx's provider remains mounted above the auth gate.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../../", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));

test("useVoiceNoteRecorder is called only by RecorderProvider", () => {
  const callers = files.filter((file) => /\buseVoiceNoteRecorder\(/.test(file.text) && !file.path.endsWith("useVoiceNoteRecorder.ts"));
  expect(callers.map((file) => file.path)).toEqual(["capture/recorder/RecorderProvider.tsx"]);
  const provider = files.find((file) => file.path === "capture/recorder/RecorderProvider.tsx")!.text;
  expect(provider.match(/\buseVoiceNoteRecorder\(/g)).toHaveLength(1);
});

test("the controller is created only by useVoiceNoteRecorder", () => {
  const creators = files.filter(
    (file) => /\bcreateVoiceNoteRecorderController\(/.test(file.text) && !file.path.endsWith("voiceNoteRecorderController.ts"),
  );
  expect(creators.map((file) => file.path)).toEqual(["capture/recorder/useVoiceNoteRecorder.ts"]);
});

test("the save singletons are defined only in recorderSaves.ts", () => {
  for (const definition of [/function savePendingRecordings\(/, /function saveRecording\(/, /const savesInFlight = /, /const savedThisSession = /, /let pendingRunInFlight/]) {
    expect(files.filter((file) => definition.test(file.text)).map((file) => file.path)).toEqual(["lib/voiceNotes/recorderSaves.ts"]);
  }
});

test("App mounts RecorderProvider exactly once above the auth gate", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  expect(app.match(/<RecorderProvider\b/g)).toHaveLength(1);
  const ready = app.slice(app.indexOf(") : isReady && tcw ? ("), app.indexOf("<BootSurface"));
  expect(app.indexOf("<RecorderProvider")).toBeLessThan(app.indexOf(") : isReady && tcw ? ("));
  expect(ready).toContain("<RecorderShell");
  expect(app).toContain("!isReady && <RecordingOverlay />");
  expect(app).not.toContain("voiceNoteOpen");
  expect(app).not.toContain("QuickVoiceNote");
  expect(app.match(/<LiveEdge \/>/g)).toHaveLength(1);
});

test("offline local home consumes the same recorder above BootSurface", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  expect(app).not.toContain("<OfflineVoiceNotes");
  expect(app).toContain("<LocalCaptureHome did={did} offline");
});
