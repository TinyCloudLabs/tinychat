import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

test("mounted App starts the first replication sync after sign-in and restore only when the user's switch is ON", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/App.replicationFill.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).toContain("4 pass");
  expect(output).toContain("0 fail");
});
