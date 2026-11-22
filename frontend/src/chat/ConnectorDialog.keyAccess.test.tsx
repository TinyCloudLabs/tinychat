import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Isolated: the fixture installs a DOM before Radix loads and fakes OpenKey's window module-wide.
test("connect dialogs ask OpenKey for the connector's own key before saving it", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/ConnectorDialog.keyAccess.fixture.tsx"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}, 35_000);
