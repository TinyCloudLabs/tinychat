// OneAppScreen frames only what registry.ts `framedApp` allows. The fixture replaces the registry module, so it runs in
// its own process.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

test("an app listed by the new navigation but unknown to framedApp is never framed", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/oneAppScreen.allowlist.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("0 fail");
}, 60_000);
