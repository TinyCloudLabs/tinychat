// One recorder controller (plan §4.2, §8.3): source guards for what a second
// copy would break. App.tsx's own wiring (RecorderProvider once, in the ready
// branch) is asserted when the provider is mounted there.
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

test("the save singletons are defined only in recorderSaves.ts", () => {
  for (const definition of [/function savePendingRecordings\(/, /function saveRecording\(/, /const savesInFlight = /, /const savedThisSession = /, /let pendingRunInFlight/]) {
    expect(files.filter((file) => definition.test(file.text)).map((file) => file.path)).toEqual(["lib/voiceNotes/recorderSaves.ts"]);
  }
});
