import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

test("mounted desktop App shows the re-sign notice on the offline recorder screen after a forced clear", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/App.resignForward.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
