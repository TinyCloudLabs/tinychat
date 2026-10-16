import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

// Other auth suites replace SDK modules. Run the pinned implementation in its own process.
test("pinned native SDK preserves stored-host grants across app host changes", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/openkeyNativeStoredHost.fixture.ts"], {
    cwd: frontendRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 65_000);
