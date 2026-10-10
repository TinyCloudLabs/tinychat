import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}
test("only the voice-note pipeline and compatibility export import the space lane", () => {
  const imports = files(root).filter((file) => /(?:from|export\s+\{[^}]*\}\s+from)\s+["'][^"']*spaceWriteLane/.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file)).sort();
  expect(imports).toEqual([
    "chat/useBackgroundDrain.ts", "lib/voiceNotes/voiceNoteRows.ts", "lib/voiceNotes/voiceNoteStore.ts",
  ]);
});
