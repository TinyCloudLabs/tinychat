import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));
const TEMP_HOME_PREFIX = "/var/tmp/tc1769.";

test("the node address setting and the first-use question, mounted", () => {
  const home = mkdtempSync(TEMP_HOME_PREFIX);
  try {
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
  } finally {
    // Only the directory made above, and only if it is still under the temp prefix.
    if (home.startsWith(TEMP_HOME_PREFIX) && !home.includes("..")) rmSync(home, { recursive: true, force: true });
  }
}, 130_000);
