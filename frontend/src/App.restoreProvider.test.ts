import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

test("mounted App restores with a read-only account provider only when the local copy is on", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/App.restoreProvider.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).toContain("2 pass");
  expect(output).toContain("0 fail");
});
