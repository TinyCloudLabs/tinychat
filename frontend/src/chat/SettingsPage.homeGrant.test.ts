import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

// VITE_HOME_SITE is read when the module loads, so each build runs in its own process.
function runFixture(homeSite: boolean) {
  const env = { ...process.env };
  if (homeSite) env.VITE_HOME_SITE = "true";
  else delete env.VITE_HOME_SITE;
  const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/SettingsPage.homeGrant.fixture.tsx"], { cwd: frontendRoot, encoding: "utf8", env });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("0 fail");
}

describe("SettingsPage, by build", () => {
  test("the Home build hides the sections that only serve Recording and Connectors", () => runFixture(true));
  test("the plain build keeps them", () => runFixture(false));
});
