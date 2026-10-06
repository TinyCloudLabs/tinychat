// The Library's reads (TC-761): TinyCloud drops concurrent responses on one
// space, so every storage call goes through the per-space queue, and the
// list and note reads wait on one chain. Pinned against the source (the
// behaviour itself is in useLibrary.test.tsx).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "useLibrary.ts"), "utf8");
const code = source.replace(/^\s*\/\/.*$/gm, "");

/** The index just past the bracket that closes the one at `open`. */
function closing(text: string, open: number): number {
  const [opener, closer] = text[open] === "(" ? ["(", ")"] : ["{", "}"];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced ${opener} at ${open}`);
}

/** Everything that runs as a task on the chain: each enqueue(...) argument, or the body of the function it names. */
function chained(text: string): string {
  const tasks = new Set<string>();
  for (const match of text.matchAll(/\benqueue\(/g)) {
    const open = match.index! + "enqueue".length;
    const arg = text.slice(open + 1, closing(text, open) - 1).trim();
    if (/^[A-Za-z_]\w*$/.test(arg)) {
      const definition = text.indexOf(`const ${arg} = `);
      expect(definition).toBeGreaterThan(-1);
      const body = text.indexOf("{", text.indexOf("=>", definition));
      tasks.add(text.slice(body, closing(text, body)));
    } else {
      tasks.add(arg);
    }
  }
  return [...tasks].join("\n");
}

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

  test("the list and the note's reads each run as a task on the one chain", () => {
    const tasks = chained(code);
    for (const read of ["listMeetingsRead(", "readMeetingMetadata(", "readTranscript("]) {
      const everywhere = code.split(read).length - 1;
      expect(everywhere).toBeGreaterThan(0);
      // Every call is inside a chained task: none runs beside the chain.
      expect(tasks.split(read).length - 1).toBe(everywhere);
    }
  });

  test("an audio file is read through the queue alone (its parts interleave), with the player's signal", () => {
    expect(chained(code)).not.toContain("getAudio(");
    expect(chained(code)).not.toContain("loadVoiceNoteAudioBlob(");
    expect(code).toContain("loadVoiceNoteAudioBlob(space, voiceSourceId, { signal, onProgress })");
    expect(code).toContain("getAudio(space.kv, audioBase, { signal, onProgress })");
  });

  test("the list is read only in refresh", () => {
    expect(code.match(/listMeetingsRead\(/g)).toHaveLength(1);
    const refresh = code.slice(code.indexOf("const refresh = useCallback("), code.indexOf("}, [enqueue, space]);"));
    expect(refresh).toContain("listMeetingsRead(space)");
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
