import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Isolate Radix's import-time browser detection.
test("Granola CSV import error lines", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/GranolaCsvImport.errorLines.fixture.tsx"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 65_000);
