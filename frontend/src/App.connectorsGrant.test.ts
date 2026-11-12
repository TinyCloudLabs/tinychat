import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

test("mounted App: the web sign-in leaves out Connectors' secrets and decrypt grant until Connectors asks for them in place", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/App.connectorsGrant.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("0 fail");
}, 60_000);
