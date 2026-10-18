import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

// A separate process keeps React/Radix's import-time DOM detection and any other
// suite's Bun module mocks from changing which consumer/engine these tests run.
test("mounted Google Connect dialog reaches a truthful initial-sync terminal state", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/ConnectorDialog.initialSync.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" },
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 65_000);
