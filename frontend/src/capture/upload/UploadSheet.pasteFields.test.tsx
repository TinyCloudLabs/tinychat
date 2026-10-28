import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../../../", import.meta.url));

// A separate process keeps React/Radix/vaul's import-time DOM detection and
// any other suite's Bun module mocks from changing what the sheet renders.
test("the mounted Upload sheet's paste fields render 16px on touch", () => {
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/UploadSheet.pasteFields.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" },
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 65_000);
