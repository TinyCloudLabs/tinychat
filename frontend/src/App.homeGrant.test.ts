import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));

// VITE_HOME_SITE is read when App loads, so each build runs in its own process (mock.module is process-wide too).
function runFixture(fixture: string, homeSite: boolean) {
  const env = { ...process.env };
  if (homeSite) env.VITE_HOME_SITE = "true";
  else delete env.VITE_HOME_SITE;
  const result = spawnSync(process.execPath, ["test", "--isolate", fixture], { cwd: frontendRoot, encoding: "utf8", env });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("0 fail");
}

describe("mounted App, by build", () => {
  test("the Home build signs in with the narrow grant, asks for Recording and Connectors in place, and runs their lanes only once permitted", () => {
    runFixture("./test-fixtures/App.homeGrant.fixture.tsx", true);
  }, 60_000);
  test("the plain build keeps the full grant, its lanes and its screens", () => {
    runFixture("./test-fixtures/App.homeGrant.fixture.tsx", false);
  }, 60_000);
});
