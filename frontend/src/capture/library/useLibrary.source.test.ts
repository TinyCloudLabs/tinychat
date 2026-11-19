// The Library's reads (TC-761): TinyCloud drops concurrent responses on one
// space, so every storage call goes through the per-space queue, and the
// list and note reads wait on one chain. Pinned against the source (the
// behaviour itself is in useLibrary.test.tsx).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "useLibrary.ts"), "utf8");
const code = source.replace(/^\s*\/\/.*$/gm, "");

describe("useLibrary reads", () => {
  test("everything through the per-space queue, and nothing from the raw session", () => {
    expect(code).toContain("const space = useMemo(() => scheduledSpace(tcw), [tcw]);");
    for (const read of ["listMeetingsRead(space)", "readMeetingMetadata(space, note.id)", "readTranscript(space, note.source, note.sourceId)", "loadVoiceNoteAudioBlob(space,", "getAudio(space.kv,"]) {
      expect(code).toContain(read);
    }
    expect(code).not.toMatch(/\b(listMeetingsRead|readMeetingMetadata|readTranscript|loadVoiceNoteAudioBlob)\(tcw\b/);
    expect(code).not.toContain("tcw.kv");
    expect(code).not.toContain("tcw.sql");
  });
});
