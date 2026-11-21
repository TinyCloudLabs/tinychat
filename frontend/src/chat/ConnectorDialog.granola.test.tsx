import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Isolate React/Radix's import-time DOM detection and the disabled build flag.
test("Granola flag off leaves setup unavailable and unrecognized connectors refuse keys", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/ConnectorDialog.granola.fixture.tsx"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, VITE_GRANOLA_CONNECTOR_ENABLED: "false" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 35_000);
