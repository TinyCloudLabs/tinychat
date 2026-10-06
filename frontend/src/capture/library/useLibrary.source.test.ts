// The Library's reads (TC-761): TinyCloud drops concurrent responses on one
// space, so every storage call goes through the per-space queue and one chain,
// never in parallel. Pinned against the source, like the other storage lanes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "useLibrary.ts"), "utf8");
const code = source.replace(/^\s*\/\/.*$/gm, "");

describe("useLibrary reads", () => {
  test("never in parallel", () => {
    expect(code).not.toContain("Promise.all");
    expect(code).not.toContain("Promise.allSettled");
  });

  test("everything through the per-space queue, and nothing from the raw session", () => {
    expect(code).toContain("const space = useMemo(() => scheduledSpace(tcw), [tcw]);");
    for (const read of ["listMeetingsRead(space)", "readMeetingMetadata(space, note.id)", "readTranscript(space, note.source, note.sourceId)", "loadVoiceNoteAudioBlob(space,", "getAudio(space.kv,"]) {
      expect(code).toContain(read);
    }
    expect(code).not.toMatch(/\b(listMeetingsRead|readMeetingMetadata|readTranscript|loadVoiceNoteAudioBlob)\(tcw\b/);
    expect(code).not.toContain("tcw.kv");
    expect(code).not.toContain("tcw.sql");
  });

  test("each read waits on one chain", () => {
    expect(code).toContain("const run = chain.current.then(task, task);");
    for (const call of ["listMeetingsRead(", "readMeetingMetadata(", "readTranscript(", "loadVoiceNoteAudioBlob(", "getAudio("]) {
      const at = code.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      expect(code.lastIndexOf("enqueue(", at)).toBeGreaterThan(-1);
    }
  });

  test("the list is read only in refresh", () => {
    expect(code.match(/listMeetingsRead\(/g)).toHaveLength(1);
    const refresh = code.slice(code.indexOf("const refresh = useCallback("), code.indexOf("}, [enqueue, space]);"));
    expect(refresh).toContain("listMeetingsRead(space)");
  });

  test("it re-lists when something lands and on entry", () => {
    expect(code).toContain('captureEvents.on("library-changed"');
    expect(code).toContain("if (options.visible) refresh();");
  });
});

describe("the recorder's Open", () => {
  const open = readFileSync(join(import.meta.dir, "useOpenSavedNote.ts"), "utf8");

  test("one read through the per-space queue, then the note's address, only while the Library still shows", () => {
    expect(open).toContain("findMeetingId(scheduledSpace(tcw), VOICE_NOTE_SOURCE, recordingId)");
    expect(open).toContain('if (read.status === "ok" && path.current === PATHS.library) navigate(notePath(read.id), { replace: true });');
    expect(open.indexOf("navigate(PATHS.library")).toBeLessThan(open.indexOf("findMeetingId("));
  });
});
