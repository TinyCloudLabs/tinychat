import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

test("the node address setting and the first-use question, mounted", () => {
  const home = mkdtempSync("/var/tmp/tc1769.");
  const result = spawnSync(process.execPath, ["test", "--isolate", "--timeout", "20000", "./test-fixtures/NodeAddressSettings.fixture.tsx"], {
    cwd: frontendRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, HOME: home, BUN_INSTALL_CACHE_DIR: `${home}/cache` },
  });
  expect(result.error).toBeUndefined();
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toMatch(/\b1\d pass/);
}, 130_000);
