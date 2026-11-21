import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Meeting sources offers Granola Connect only when the flag is on", () => {
  for (const enabled of ["false", "true"]) {
    const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/MeetingSourcesDialog.granolaVisibility.fixture.tsx"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, VITE_GRANOLA_CONNECTOR_ENABLED: enabled },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `Granola flag ${enabled}\n${result.stderr}${result.stdout}`).toBe(0);
  }
}, 35_000);
