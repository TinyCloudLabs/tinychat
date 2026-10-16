import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

// Auth suites replace SDK modules; browser globals and the pinned SDK stay in this child process.
test("pinned web SDK keeps sessions and signed shares on their original host", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/tinycloudSessionHost.fixture.ts"], {
    cwd: frontendRoot,
    encoding: "utf8",
    timeout: 60_000,
    // Bun can print the pinned SDK's multi-megabyte minified source line on failure.
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 65_000);
