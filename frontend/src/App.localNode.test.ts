import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));
const TEMP_HOME_PREFIX = "/var/tmp/tc1769.";

// The address is read once when App loads, so each setup runs in its own process.
function runFixture(mode: "local" | "hosted") {
  const home = mkdtempSync(TEMP_HOME_PREFIX);
  try {
    const result = spawnSync(process.execPath, ["test", "--isolate", "--timeout", "20000", "./test-fixtures/App.localNode.fixture.tsx"], {
      cwd: frontendRoot,
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, HOME: home, BUN_INSTALL_CACHE_DIR: `${home}/cache`, NODE_FIXTURE_MODE: mode },
    });
    expect(result.error).toBeUndefined();
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    return output;
  } finally {
    // Only the directory made above, and only if it is still under the temp prefix.
    if (home.startsWith(TEMP_HOME_PREFIX) && !home.includes("..")) rmSync(home, { recursive: true, force: true });
  }
}

test("mounted App with a node on this computer: the node ID check, refusal, restore and the reset path", () => {
  const output = runFixture("local");
  expect(output).toContain("15 pass");
  expect(output).toContain("0 fail");
}, 250_000);

test("mounted App with no node address: the default is unchanged and no node ID is asked for", () => {
  const output = runFixture("hosted");
  expect(output).toContain("3 pass");
  expect(output).toContain("0 fail");
}, 250_000);
