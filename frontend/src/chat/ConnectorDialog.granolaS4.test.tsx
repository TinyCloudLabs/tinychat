import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Isolate Radix's import-time browser detection and the opt-in Vite flag.
test("Granola connect, recovery and summary-only states through Meeting sources", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/ConnectorDialog.granolaS4.fixture.tsx"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, VITE_GRANOLA_CONNECTOR_ENABLED: "true" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 35_000);
