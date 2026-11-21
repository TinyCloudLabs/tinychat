import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Radix captures its browser environment at import time; isolate the real detail's DOM.
test("Granola CSV deletion through the Library detail", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/testing/NoteDetail.granolaDelete.fixture.tsx"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 65_000);
