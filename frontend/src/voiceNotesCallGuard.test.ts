// One recorder controller: only these files may drive the native VoiceNotes
// plugin (listen, start, stop, delete audio). A second caller would mean a
// second recorder racing the first for the microphone and its saves. The
// redesign's recorder (TC-761) moved the controller to
// voiceNoteRecorderController (wrapped by useVoiceNoteRecorder) and the saves
// to recorderSaves.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;
const ALLOWED = [
  "capture/recorder/voiceNoteRecorderController.ts",
  "lib/voiceNotes/recorderSaves.ts",
  "chat/OfflineVoiceNotes.tsx",
  "lib/voiceNotes/nativeVoiceNotes.ts",
  "lib/voiceNotes/legacyMigration.ts",
];
const PLUGIN_CALL = /VoiceNotes\.(addListener|start|stop|pause|resume|discard|deleteAudio)\(/;

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
    expect.arrayContaining(["capture/recorder/voiceNoteRecorderController.ts", "lib/voiceNotes/recorderSaves.ts", "chat/OfflineVoiceNotes.tsx"]),
  );
  const deletes = sources(SRC).filter((path) => /VoiceNotes\.deleteAudio\(/.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path));
  expect(deletes).toEqual(["lib/voiceNotes/legacyMigration.ts", "lib/voiceNotes/recorderSaves.ts"]);
  const savesSource = readFileSync(join(SRC, "lib/voiceNotes/recorderSaves.ts"), "utf8");
  expect(savesSource.match(/VoiceNotes\.deleteAudio\(/g)).toHaveLength(1);
  expect(savesSource.indexOf("VoiceNotes.deleteAudio(")).toBeGreaterThan(savesSource.indexOf("async function deleteDiscardedOnce"));
});
