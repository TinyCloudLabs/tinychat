// VITE_ONE_NAV and VITE_ONE_ADD_APP (shell/navPins.ts) are read when the modules load, so each setting runs in its own
// process with the flags in its environment, as a build would set them. A flag not named is unset.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

function run(fixture: string, flags: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env, ...flags };
  for (const name of ["VITE_ONE_NAV", "VITE_ONE_ADD_APP"]) if (!(name in flags)) delete env[name];
  const result = spawnSync(process.execPath, ["test", "--isolate", fixture], { cwd: frontendRoot, env, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("0 fail");
}

test("production as it ships (One Apps on, VITE_ONE_NAV unset) renders today's navigation and Apps page", () => {
  run("./test-fixtures/oneNav.off.fixture.tsx", { VITE_ONE_APPS: "true" });
}, 60_000);

test("VITE_ONE_NAV=true without VITE_ONE_ADD_APP: the pill and the grid, with no Add an app tile or route", () => {
  run("./test-fixtures/oneNav.noAdd.fixture.tsx", { VITE_ONE_APPS: "true", VITE_ONE_NAV: "true" });
}, 60_000);

test("VITE_ONE_ADD_APP=true as well (previews): the grid ends with Add an app, which has its own screen", () => {
  run("./test-fixtures/oneNav.on.fixture.tsx", { VITE_ONE_APPS: "true", VITE_ONE_NAV: "true", VITE_ONE_ADD_APP: "true" });
}, 60_000);
