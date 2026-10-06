// One recorder controller: only these files may drive the native VoiceNotes
// plugin (listen, start, stop, delete audio). A second caller would mean a
// second recorder racing the first for the microphone and its saves. The
// redesign's recorder (TC-761) moved the controller to useVoiceNoteRecorder
// and the saves to recorderSaves; the Voice notes card keeps its own controller
// until it is split (PR4, with the app wiring), then leaves this list.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;
const ALLOWED = [
  "capture/recorder/useVoiceNoteRecorder.ts",
  "lib/voiceNotes/recorderSaves.ts",
  "chat/OfflineVoiceNotes.tsx",
  "lib/voiceNotes/nativeVoiceNotes.ts",
  "chat/VoiceNotesSection.tsx",
];
const PLUGIN_CALL = /VoiceNotes\.(addListener|start|stop|deleteAudio)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("only the recorder's own files call the VoiceNotes plugin", () => {
  const callers = sources(SRC)
    .filter((path) => PLUGIN_CALL.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path))
    .sort();
  expect(callers.filter((path) => !ALLOWED.includes(path))).toEqual([]);
  // The guard still sees the callers it exists for.
  expect(callers).toEqual(
    expect.arrayContaining(["capture/recorder/useVoiceNoteRecorder.ts", "lib/voiceNotes/recorderSaves.ts", "chat/OfflineVoiceNotes.tsx"]),
  );
});
